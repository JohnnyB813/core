"""Offline real Stratum submissions against a synthetic, easy-target database.

Run only inside an isolated Linux network namespace. The unmodified node checks
each newly found header, PoW, body, signature and balance. The seeded base is not
a valid network history. This fixture must never be used on a connected node.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import select
import shutil
import socket
import sqlite3
import statistics
import subprocess
import tempfile
import time
import urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def rpc(path, data=None):
    request = urllib.request.Request('http://127.0.0.1:3000/' + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'})
    with OPENER.open(request, timeout=10) as response:
        value = json.load(response)
    assert value['code'] == 0, (path, value)
    return value['data']


class Worker:
    def __init__(self, payout):
        self.socket = socket.create_connection(('127.0.0.1', 3456), timeout=5)
        self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.socket.settimeout(10)
        self.buffer = b''
        self.sequence = 0
        self.send('mining.subscribe', [])
        subscription = self.response()
        assert subscription['error'] is None
        self.prefix = subscription['result'][1]
        self.authorize(payout)

    def send(self, method, params):
        self.sequence += 1
        self.socket.sendall((json.dumps({'id': self.sequence, 'method': method, 'params': params})+'\n').encode())
        return self.sequence

    def read(self):
        while b'\n' not in self.buffer:
            chunk = self.socket.recv(65536)
            assert chunk, 'Stratum disconnected'
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b'\n', 1)
        return json.loads(line)

    def response(self):
        while True:
            message = self.read()
            if message.get('id') == self.sequence:
                return message
            self.consume(message)

    def consume(self, message):
        if message.get('method') == 'mining.set_difficulty':
            self.difficulty = message['params'][0]
        else:
            assert message.get('method') == 'mining.notify', message
            self.job = message['params']

    def next_job(self, previous=None):
        while True:
            message = self.read()
            self.consume(message)
            if message.get('method') == 'mining.notify' and (previous is None or self.job[1] != previous):
                return self.job

    def authorize(self, payout):
        self.send('mining.authorize', [payout+'.submission-test', 'x'])
        response = self.response()
        assert response['result'] is True and response['error'] is None
        self.next_job()
        assert self.job[-1] is True

    def submit(self, job, extra, timestamp, nonce):
        started = time.perf_counter_ns()
        self.send('mining.submit', [job, extra, timestamp, nonce])
        response = self.response()
        return response, (time.perf_counter_ns()-started)/1000

    def close(self):
        self.socket.close()


def stats(values):
    ordered = sorted(values)
    return {'median_us': statistics.median(ordered),
            'p95_us': ordered[max(0, (95*len(ordered)+99)//100-1)], 'samples': len(values)}


def cpu_us(process):
    fields = Path(f'/proc/{process.pid}/stat').read_text().split()
    return (int(fields[13])+int(fields[14]))*1000000/os.sysconf('SC_CLK_TCK')


def ledger(path):
    with sqlite3.connect(path) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        return db.execute('SELECT rowid,hex(address),balance FROM State ORDER BY rowid').fetchall()


def bodies(path):
    with sqlite3.connect(path) as db:
        return [hashlib.sha256(row[0][10:]).hexdigest() for row in db.execute(
            'SELECT b.body FROM Consensus c JOIN Blocks b ON c.block_id=b.rowid WHERE c.height>3 ORDER BY c.height')]


def run(binary, fixture_tool, base, directory, transfers, accepted_samples, rejected_samples, controls):
    directory.mkdir()
    shutil.copy2(base/'chain.db', directory/'chain.db')
    fixture = json.loads((base/'fixture.json').read_text())
    log = (directory/'node.log').open('w')
    process = subprocess.Popen([str(binary), '--testnet', '--chain-db='+str(directory/'chain.db'),
        '--peers-db='+str(directory/'peers.db'), '--bind=127.0.0.1:9186', '--rpc=127.0.0.1:3000',
        '--stratum=127.0.0.1:3456', '--chain-db-journal=wal',
        '--latency-log='+('summary' if os.environ.get('STRATUM_SUBMISSION_PROFILE') else 'off'),
        '--block-peer-selection=legacy'], env=dict(os.environ, HOME=str(directory)), stdout=log, stderr=log)
    workers = []
    try:
        deadline = time.monotonic()+15
        while True:
            try:
                assert rpc('chain/head')['height'] == 3
                break
            except OSError:
                assert process.poll() is None, (directory/'node.log').read_text()
                assert time.monotonic() < deadline
                time.sleep(.02)
        rpc('settings/mempool/minfee/1')
        accepted, rejected, fresh_job = [], [], []
        accepted_cpu = 0
        request_index = 0
        old_job = None
        for sample in range(accepted_samples):
            for worker in workers: worker.close()
            workers.clear()
            requests = fixture['requests'][request_index:request_index+transfers]
            assert len(requests) == transfers
            request_index += transfers
            # Equal-fee insertion order affects transaction order and SQLite
            # history writes. Keep the workload identical in paired trials.
            for request in requests: rpc('transaction/add', request)
            payout = fixture['payout'] if sample % 2 == 0 else fixture['other_payout']
            task = rpc('chain/mine/'+payout)
            assert task['height'] == 4+sample and task['totalTxFeeE8'] == transfers, task
            primary, observer = Worker(payout), Worker(payout)
            workers.extend([primary, observer])
            assert primary.job == observer.job and primary.prefix != observer.prefix
            job = primary.job.copy()
            assert job[2] == task['merklePrefix'] and job[1] == task['header'][:64]
            if controls and sample == 0:
                primary.authorize(payout)
                assert primary.job == job, 'reauthorization changed cached template'
                primary.authorize(fixture['other_payout'])
                wrong, _ = primary.submit(job[0], '010203040506', job[5], '00000000')
                assert wrong['error'][0] == 21, wrong
                primary.authorize(payout)
                job = primary.job.copy()
            if old_job:
                stale, _ = primary.submit(old_job[0], '010203040506', old_job[5], '00000000')
                assert stale['error'][0] == 21, stale
            # Rejected requests still traverse real parsing, cache lookup, body
            # copying/root preparation, queueing and the ordinary header checks.
            for attempt in range(rejected_samples if sample == 0 else 0):
                if attempt == 20: rejected_cpu_start = cpu_us(process)
                rejected_reply, us = primary.submit(job[0], attempt.to_bytes(6,'big').hex(), '00000000', '00000000')
                assert rejected_reply['error'][0] == 40, rejected_reply
                if attempt >= 20: rejected.append(us)
            if sample == 0 and rejected: rejected_cpu = cpu_us(process)-rejected_cpu_start
            extra = (sample+1).to_bytes(6,'big').hex()
            root = hashlib.sha256(bytes.fromhex(job[2]+primary.prefix+extra)).digest()
            raw_header = bytes.fromhex(job[1]+job[4])+root+bytes.fromhex(job[3]+job[5]) + bytes(4)
            assert len(raw_header) == 80
            solution = json.loads(subprocess.check_output([str(fixture_tool),'solve',raw_header.hex(),str(task['height'])],text=True))
            cpu_before = cpu_us(process)
            before = time.perf_counter_ns()
            reply, us = primary.submit(job[0], extra, job[5], solution['nonce'])
            assert reply['result'] is True and reply['error'] is None, reply
            primary.next_job(previous=job[1])
            fresh_job.append((time.perf_counter_ns()-before)/1000)
            observer.next_job(previous=job[1])
            accepted_cpu += cpu_us(process)-cpu_before
            assert primary.job == observer.job
            accepted.append(us)
            head = rpc('chain/head')
            assert head['height'] == task['height']
            block = rpc('chain/block/'+str(task['height']))
            assert block['header']['raw'] == solution['header'], 'accepted header differs from submitted bytes'
            assert len(block['body'].get('transfers',[])) == transfers
            assert rpc('transaction/mempool')['data'] == []
            if controls:
                stale, _ = primary.submit(job[0], extra, job[5], solution['nonce'])
                assert stale['error'][0] == 21, stale
                assert rpc('chain/head')['height'] == task['height']
            old_job = job
        result = {'transfers':transfers, 'accepted':stats(accepted[2:] if len(accepted)>4 else accepted),
                  'accepted_submissions':len(accepted), 'rejected':stats(rejected) if rejected else None,
                  'rejected_server_cpu_us_per_request':rejected_cpu/len(rejected) if rejected else None,
                  'accepted_server_cpu_us_per_request':accepted_cpu/accepted_samples,
                  'submission_to_fresh_job':stats(fresh_job), 'final_height':rpc('chain/head')['height'],
                  'accepted_header_bytes_verified':accepted_samples,'two_same_payout_receivers':True,
                  'payout_changes_reauthorization_and_stale_jobs':controls}
    except BaseException:
        log.flush()
        print('STRATUM_SUBMISSION_DIAGNOSTICS '+str(directory),flush=True)
        print((directory/'node.log').read_text(errors='replace')[-8000:],flush=True)
        raise
    finally:
        for worker in workers: worker.close()
        process.terminate()
        try: code = process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait(); raise AssertionError('node shutdown hung')
        log.close()
    assert code == 0, (code, (directory/'node.log').read_text()[-4000:])
    result['balances'] = ledger(directory/'chain.db')
    result['body_content_hashes'] = bodies(directory/'chain.db')
    preparation = [int(us) for us in re.findall(r'STRATUM_ACCEPTED_PREPARATION_US (\d+)', (directory/'node.log').read_text())]
    if os.environ.get('STRATUM_SUBMISSION_PROFILE'):
        assert len(preparation) == accepted_samples, (len(preparation), accepted_samples)
        result['accepted_preparation'] = stats(preparation[2:] if len(preparation)>4 else preparation)
    (directory/'result.json').write_text(json.dumps(result,indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--fixture-tool', type=Path, required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=5)
    parser.add_argument('--accepted', type=int, default=10)
    parser.add_argument('--rejected', type=int, default=220)
    args = parser.parse_args()
    # Reject a normal host network: Docker --network none exposes only loopback.
    assert {p.name for p in Path('/sys/class/net').iterdir()} == {'lo'}, 'isolated loopback namespace required'
    args.results.mkdir(parents=True,exist_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='warthog-submit-') as temporary:
        root = Path(temporary)
        base = root/'base'
        subprocess.run([str(args.fixture_tool),'seed',str(base)],check=True)
        versions = [('candidate',args.candidate)]
        if args.baseline: versions.insert(0,('baseline',args.baseline))
        for repeat in range(args.rounds):
            for transfers in (0,100,300):
                paired = {}
                for version,binary in versions[::(-1 if repeat % 2 else 1)]:
                    name = f'{version}-{transfers}-{repeat}'
                    result = run(binary,args.fixture_tool,base,root/name,transfers,args.accepted,args.rejected,True)
                    row = dict(version=version,round=repeat,**result)
                    rows.append(row); paired[version] = result
                    shutil.copy2(root/name/'node.log',args.results/(name+'.log'))
                    print(json.dumps({k:v for k,v in row.items() if k!='balances'}),flush=True)
                if args.baseline:
                    assert paired['baseline']['balances'] == paired['candidate']['balances']
                    assert paired['baseline']['body_content_hashes'] == paired['candidate']['body_content_hashes'], 'paired bodies differ beyond the mining seed'
                (args.results/'results.json').write_text(json.dumps(rows,indent=2))
    print('STRATUM_REAL_SUBMISSIONS_PASSED',flush=True)


if __name__ == '__main__': main()
