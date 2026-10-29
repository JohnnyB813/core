#!/usr/bin/env python3
"""Sync a genuine testnet block between two node binaries in both directions.

Requires an isolated Linux network namespace and the offline fixture helper.
The synthetic funded base must never be connected to a production network.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

from websocket_subscribers import WebSocket


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def rpc(host, port, path, payload=None):
    request = urllib.request.Request(f'http://{host}:{port}/{path}',
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'})
    with OPENER.open(request, timeout=5) as response:
        result = json.load(response)
    assert result['code'] == 0, (path, result)
    return result.get('data')


def wait_for(predicate, processes, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        assert all(process.poll() is None for process in processes), 'node exited during sync'
        try:
            if predicate():
                return
        except OSError:
            pass
        time.sleep(.05)
    raise AssertionError('node sync timed out')


def launch(binary, home, host, p2p, rpc_port, connect, public=False):
    config = home / 'probe.toml'
    config.write_text('[node]\nallow-localhost-ip=true\n')
    log = (home / 'node.log').open('w')
    command = [str(binary), '--testnet', '--chain-db=' + str(home / 'chain.db'),
        '--peers-db=' + str(home / 'peers.db'), '--config=' + str(config),
        '--bind=' + host + ':' + str(p2p), '--rpc=' + host + ':' + str(rpc_port),
        '--connect=' + connect, '--chain-db-journal=wal']
    if public:
        command.append('--publicrpc=' + host + ':3002')
    process = subprocess.Popen(command, cwd=home, env=dict(os.environ, HOME=str(home)),
        stdout=log, stderr=subprocess.STDOUT)
    return process, log


def trial(root, base, fixture, helper, source_binary, receiver_binary, candidate, direction):
    directory = root / direction
    directory.mkdir()
    source_home = directory / 'source'
    receiver_home = directory / 'receiver'
    source_home.mkdir()
    receiver_home.mkdir()
    for home in (source_home, receiver_home):
        shutil.copy2(base / 'chain.db', home / 'chain.db')
    processes, logs, sockets = [], [], []
    try:
        source_is_candidate = source_binary == candidate
        source, source_log = launch(source_binary, source_home, '127.0.0.1', 9186, 3000,
            '127.0.0.1:1', source_is_candidate)
        processes.append(source)
        logs.append(source_log)
        wait_for(lambda: rpc('127.0.0.1', 3000, 'chain/head')['height'] == 3, processes)

        receiver, receiver_log = launch(receiver_binary, receiver_home, '127.0.0.2', 9187, 3001,
            '127.0.0.1:9186', not source_is_candidate)
        processes.append(receiver)
        logs.append(receiver_log)
        wait_for(lambda: rpc('127.0.0.2', 3001, 'chain/head')['height'] == 3, processes)
        candidate_host, candidate_port = (('127.0.0.1', 3000) if source_is_candidate
            else ('127.0.0.2', 3001))
        private = WebSocket(candidate_port, candidate_host)
        public = WebSocket(3002, candidate_host)
        sockets.extend((private, public))

        for height in range(4, 7):
            task = rpc('127.0.0.1', 3000, 'chain/mine/' + fixture['payout'])
            assert task['height'] == height, task
            solution = json.loads(subprocess.check_output(
                [str(helper), 'solve', task['header'], str(task['height'])], text=True))
            rpc('127.0.0.1', 3000, 'chain/append', {
                'height': task['height'], 'header': solution['header'], 'body': task['body']})
            wait_for(lambda: rpc('127.0.0.2', 3001, 'chain/head')['height'] == height, processes)
            private_event = private.read()
            public_event = public.read()
            assert private_event == public_event, 'candidate private/public events differ'
            event = json.loads(private_event)
            assert event['type'] == 'blockAppend' and event['data']['height'] == height, event

        source_head = rpc('127.0.0.1', 3000, 'chain/head')
        assert source_head['height'] == 6, source_head
        receiver_head = rpc('127.0.0.2', 3001, 'chain/head')
        assert receiver_head['hash'] == source_head['hash'], (source_head, receiver_head)
        assert receiver_head['worksumHex'] == source_head['worksumHex'], (source_head, receiver_head)
        for height in range(4, 7):
            source_block = rpc('127.0.0.1', 3000, 'chain/block/' + str(height))
            receiver_block = rpc('127.0.0.2', 3001, 'chain/block/' + str(height))
            assert receiver_block['header']['raw'] == source_block['header']['raw']
            assert receiver_block['body'] == source_block['body']
        source_balance = rpc('127.0.0.1', 3000, 'account/' + fixture['payout'] + '/balance')
        receiver_balance = rpc('127.0.0.2', 3001, 'account/' + fixture['payout'] + '/balance')
        assert receiver_balance == source_balance
        print('MIXED_SYNC_PASS ' + json.dumps({'direction': direction, 'blocks': 3,
            'matching_private_public_events': 3, 'height': 6,
            'hash': receiver_head['hash'], 'worksumHex': receiver_head['worksumHex']}), flush=True)
    except BaseException:
        for home in (source_home, receiver_home):
            log = home / 'node.log'
            if log.exists():
                print(str(log) + ':\n' + log.read_text(errors='replace')[-5000:], flush=True)
        raise
    finally:
        for socket in reversed(sockets):
            socket.close()
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in reversed(processes):
            assert process.wait(timeout=20) == 0, 'node did not shut down cleanly'
        for log in logs:
            log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--fixture-tool', type=Path, required=True)
    args = parser.parse_args()
    candidate, baseline, helper = (path.resolve() for path in
        (args.candidate, args.baseline, args.fixture_tool))
    assert all(path.is_file() for path in (candidate, baseline, helper))
    with tempfile.TemporaryDirectory(prefix='mixed-websocket-sync-') as temporary:
        root = Path(temporary)
        base = root / 'base'
        subprocess.run([str(helper), 'seed', str(base)], check=True)
        fixture = json.loads((base / 'fixture.json').read_text())
        print('MIXED_SYNC_BINARIES ' + json.dumps({
            'candidate_sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(),
            'baseline_sha256': hashlib.sha256(baseline.read_bytes()).hexdigest()}), flush=True)
        trial(root, base, fixture, helper, baseline, candidate, candidate, 'baseline-to-candidate')
        trial(root, base, fixture, helper, candidate, baseline, candidate, 'candidate-to-baseline')


if __name__ == '__main__':
    main()
