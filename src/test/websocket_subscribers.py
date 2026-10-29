#!/usr/bin/env python3
"""Exercise one endpoint's event loop over real loopback HTTP/WebSocket sockets."""
import base64
import http.client
import json
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


class WebSocket:
    def __init__(self, port=34200, host='127.0.0.1'):
        self.socket = socket.create_connection((host, port), timeout=3)
        self.buffer = b''
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(('GET /ws/chain_delta HTTP/1.1\r\nHost: localhost\r\n'
            'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
            'Sec-WebSocket-Key: ' + key + '\r\n\r\n').encode())
        while b'\r\n\r\n' not in self.buffer:
            chunk = self.socket.recv(4096)
            assert chunk, 'closed during upgrade'
            self.buffer += chunk
        headers, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
        assert headers.startswith(b'HTTP/1.1 101'), headers

    def take(self, count):
        while len(self.buffer) < count:
            chunk = self.socket.recv(65536)
            if not chunk:
                raise EOFError('WebSocket closed')
            self.buffer += chunk
        value, self.buffer = self.buffer[:count], self.buffer[count:]
        return value

    def frame(self):
        opcode, length = self.take(2)
        assert opcode & 128 and not length & 128, 'fragmented or masked server frame'
        length &= 127
        if length == 126:
            length = struct.unpack('!H', self.take(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', self.take(8))[0]
        return opcode & 15, self.take(length)

    def read(self):
        opcode, payload = self.frame()
        assert opcode == 1, (opcode, payload)
        return payload

    def close(self):
        try:
            # Acknowledged close establishes removal before the next probe.
            self.socket.sendall(b'\x88\x82\x00\x00\x00\x00\x03\xe8')
            while self.frame()[0] != 8:
                pass
        except (OSError, EOFError):
            pass
        finally:
            self.socket.close()


def barrier(port=34200):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        connection.request('GET', '/tools/version')
        response = connection.getresponse()
        data = json.loads(response.read())
        assert response.status == 200 and data['code'] == 0, data
    finally:
        connection.close()


def main():
    executable, fixture = map(lambda value: str(Path(value).resolve()), sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix='websocket-subscribers-') as directory:
        process = subprocess.Popen([executable, fixture], cwd=directory,
            env=dict(os.environ, HOME=directory), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        output = queue.Queue()
        transcript = []

        def read_output():
            for line in process.stdout:
                transcript.append(line.rstrip())
                if line.startswith('COUNTS '):
                    output.put(json.loads(line[7:]))
            output.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        def command(event, **values):
            process.stdin.write(json.dumps(dict(event=event, **values)) + '\n')
            process.stdin.flush()
            result = output.get(timeout=5)
            assert result is not None, 'helper exited: ' + '\n'.join(transcript)
            return result

        def counts(blocks, rollbacks):
            # The HTTP response is deferred on the same loop after queued events.
            barrier()
            result = command('counts')
            if result['instrumented']:
                assert (result['blocks'], result['rollbacks']) == (blocks, rollbacks), result

        clients = []
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    barrier()
                    break
                except (OSError, http.client.HTTPException):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.02)
            command('reset')
            command('append', height=4, transfers=100)
            command('rollback', height=3)
            counts(0, 0)

            clients = [WebSocket(), WebSocket()]
            sequence = [('append', 4), ('append', 5), ('rollback', 3),
                        ('append', 4), ('append', 5), ('append', 6)]
            for event, height in sequence:
                command(event, height=height, transfers=100)
                frames = [client.read() for client in clients]
                assert frames[0] == frames[1], 'subscribers received different bytes'
                value = json.loads(frames[0])
                assert value['type'] == ('blockAppend' if event == 'append' else 'rollback')
                assert value['data']['height' if event == 'append' else 'length'] == height
            counts(5, 1)  # Formatting is per event, independent of client count.

            slow = WebSocket()
            clients.append(slow)
            for height in range(7, 47):
                command('append', height=height, transfers=100)
                for client in clients[:2]:
                    assert json.loads(client.read())['data']['height'] == height
            slow.close()
            clients.remove(slow)
            counts(45, 1)
            for client in clients:
                client.close()
            clients.clear()
            for index in range(8):
                client = WebSocket()
                clients.append(client)
                command('append', height=100 + index, transfers=100)
                assert json.loads(client.read())['data']['height'] == 100 + index
                client.close()
                clients.clear()
            barrier()
            command('reset')
            command('append', height=200, transfers=100)
            command('rollback', height=199)
            counts(0, 0)
            print('WebSocket: ordered append/rollback, two subscribers, unread client, '
                  'eight reconnects and zero-subscriber formatting passed')
        except BaseException:
            print('\n'.join(transcript), file=sys.stderr)
            raise
        finally:
            for client in clients:
                client.close()
            if process.poll() is None:
                process.stdin.write('{"event":"quit"}\n')
                process.stdin.flush()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
            reader.join(timeout=2)
        assert process.returncode == 0, '\n'.join(transcript)


if __name__ == '__main__':
    main()
