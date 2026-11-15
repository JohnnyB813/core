#!/usr/bin/env python3
"""Actual loopback handshakes: public advertisement must not change the bind socket."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.request


NODE = '127.77.0.1'
PEER = '127.77.0.2'
INBOUND = '127.77.0.3'


def receive(connection, count):
    data = b''
    while len(data) < count:
        chunk = connection.recv(count - len(data))
        if not chunk:
            raise AssertionError('P2P connection closed before its handshake completed')
        data += chunk
    return data


def reserve(address):
    listener = socket.socket()
    listener.bind((address, 0))
    return listener


def one_handshake(binary, advertised=None, testnet=False):
    with tempfile.TemporaryDirectory(prefix='warthog-advertised-port-') as directory:
        root = Path(directory)
        peer = reserve(PEER)
        peer.listen(1)
        peer.settimeout(15)
        bind_reservation, rpc_reservation = reserve(NODE), reserve(NODE)
        bind_port, rpc_port = bind_reservation.getsockname()[1], rpc_reservation.getsockname()[1]
        expected = bind_port if advertised is None else advertised
        configuration = root / 'node.toml'
        configuration.write_text('[node]\nallow-localhost-ip=true\n' +
                                 ('' if advertised is None else f'advertise-port={advertised}\n'))
        command = [binary, '--config=' + str(configuration), f'--bind={NODE}:{bind_port}',
                   f'--rpc={NODE}:{rpc_port}', f'--connect={PEER}:{peer.getsockname()[1]}']
        if testnet:
            command.append('--testnet')
        bind_reservation.close()
        rpc_reservation.close()
        with (root / 'node.log').open('w') as log:
            process = subprocess.Popen(command, cwd=root, env={**os.environ, 'HOME': str(root)},
                                       stdout=log, stderr=subprocess.STDOUT)
            try:
                with peer.accept()[0] as outbound:
                    outbound.settimeout(5)
                    greeting = receive(outbound, 24)
                    question = b'TESTNET GRUNT?' if testnet else b'WARTHOG GRUNT?'
                    answer = b'TESTNET GRUNT!' if testnet else b'WARTHOG GRUNT!'
                    assert greeting[:14] == question, 'wrong network handshake'
                    assert struct.unpack('>H', greeting[22:24])[0] == expected, 'wrong advertised port'
                    outbound.sendall(answer + greeting[14:18] + bytes(4))
                    assert receive(outbound, 1) == b'\x00', 'outbound handshake ack missing'
                    # A distinct loopback source checks the ordinary inbound path
                    # without changing duplicate-IP or public-network rules.
                    with socket.socket() as inbound:
                        inbound.settimeout(5)
                        inbound.bind((INBOUND, 0))
                        inbound.connect((NODE, bind_port))
                        inbound.sendall(question + greeting[14:18] + bytes(4) + struct.pack('>H', 19001))
                        reply = receive(inbound, 22)
                        assert reply[:14] == answer and reply[14:18] == greeting[14:18]
                        inbound.sendall(b'\x00')
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    deadline = time.monotonic() + 10
                    while True:
                        try:
                            with opener.open(f'http://{NODE}:{rpc_port}/chain/head', timeout=1) as response:
                                assert json.load(response)['code'] == 0
                            break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.02)
                    assert process.poll() is None, 'node exited during handshake checks'
            finally:
                peer.close()
                process.terminate()
                try:
                    status = process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise AssertionError('node failed to stop gracefully')
            assert status == 0, (root / 'node.log').read_text()[-5000:]


def configuration_checks(binary):
    with tempfile.TemporaryDirectory(prefix='warthog-advertised-config-') as directory:
        root = Path(directory)
        configuration = root / 'node.toml'
        environment = {**os.environ, 'HOME': str(root)}
        default = subprocess.run([binary, '--dump-config'], env=environment, capture_output=True, text=True, timeout=10)
        assert default.returncode == 0, default.stderr
        assert 'advertise-port' not in tomllib.loads(default.stdout)['node']
        for value in ['1', '30212', '65535']:
            configuration.write_text(f'[node]\nadvertise-port={value}\n')
            result = subprocess.run([binary, '--dump-config', '--config=' + str(configuration)],
                                    env=environment, capture_output=True, text=True, timeout=10)
            assert result.returncode == 0, result.stderr
            assert tomllib.loads(result.stdout)['node']['advertise-port'] == int(value)
        for value in ['0', '-1', '65536', 'true', '"30212"', '30212.0']:
            configuration.write_text(f'[node]\nadvertise-port={value}\n')
            result = subprocess.run([binary, '--dump-config', '--config=' + str(configuration)],
                                    env=environment, capture_output=True, text=True, timeout=10)
            assert result.returncode != 0, 'invalid advertised port accepted: ' + value


if __name__ == '__main__':
    binary = str(Path(sys.argv[1]).resolve())
    configuration_checks(binary)
    one_handshake(binary)
    one_handshake(binary, 30212)
    one_handshake(binary, 65535)
    one_handshake(binary, 30312, testnet=True)
    print('Mapped P2P advertisement, network handshakes and configuration validation passed')
