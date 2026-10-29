#!/usr/bin/env python3
"""Check ordered event delivery on separate private and public HTTP loops."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

from websocket_subscribers import WebSocket, barrier


PRIVATE = 34210
PUBLIC = 34211


def main():
    executable, fixture = map(lambda value: str(Path(value).resolve()), sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix='websocket-public-') as directory:
        process = subprocess.Popen([executable, fixture, 'dual'], cwd=directory,
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
            for port in (PRIVATE, PUBLIC):
                barrier(port)
            result = command('counts')
            if result['instrumented']:
                assert (result['blocks'], result['rollbacks']) == (blocks, rollbacks), result

        def event_pair(event, height):
            command(event, height=height, transfers=100)
            private_frame = private.read()
            public_frame = public.read()
            if private_frame != public_frame:
                first = next((i for i, pair in enumerate(zip(private_frame, public_frame))
                    if pair[0] != pair[1]), min(len(private_frame), len(public_frame)))
                raise AssertionError('private and public event bytes differ at '
                    + str(first) + ': ' + repr(private_frame[max(0, first-40):first+80])
                    + ' versus ' + repr(public_frame[max(0, first-40):first+80]))
            value = json.loads(private_frame)
            assert value['type'] == ('blockAppend' if event == 'append' else 'rollback'), value
            assert value['data']['height' if event == 'append' else 'length'] == height, value
            if event == 'append':
                header = value['data']['header']
                expected = datetime.fromtimestamp(header['timestamp'], timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
                assert header['utc'] == expected, header

        clients = []
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    barrier(PRIVATE)
                    barrier(PUBLIC)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.02)

            command('reset')
            command('append', height=4)
            command('rollback', height=3)
            counts(0, 0)

            private = WebSocket(PRIVATE)
            clients.append(private)
            command('reset')
            command('append', height=4)
            command('rollback', height=3)
            assert json.loads(private.read())['type'] == 'blockAppend'
            assert json.loads(private.read())['type'] == 'rollback'
            counts(1, 1)
            private.close()
            clients.remove(private)
            barrier(PRIVATE)

            public = WebSocket(PUBLIC)
            clients.append(public)
            command('reset')
            command('append', height=4)
            command('rollback', height=3)
            assert json.loads(public.read())['type'] == 'blockAppend'
            assert json.loads(public.read())['type'] == 'rollback'
            counts(1, 1)

            private = WebSocket(PRIVATE)
            clients.append(private)
            command('reset')
            sequence = [('append', 4), ('append', 5), ('rollback', 3),
                        ('append', 4), ('append', 5), ('append', 6)]
            for event, height in sequence:
                event_pair(event, height)
            counts(10, 2)

            slow = WebSocket(PUBLIC)
            clients.append(slow)
            for height in range(7, 47):
                event_pair('append', height)
            slow.close()
            clients.remove(slow)
            counts(90, 2)

            for client in clients:
                client.close()
            clients.clear()
            barrier(PRIVATE)
            barrier(PUBLIC)

            command('reset')
            for index in range(8):
                private, public = WebSocket(PRIVATE), WebSocket(PUBLIC)
                clients.extend((private, public))
                event_pair('append', 100 + index)
                for client in clients:
                    client.close()
                clients.clear()
            counts(16, 0)

            command('reset')
            command('append', height=200)
            command('rollback', height=199)
            counts(0, 0)
            print('Public WebSocket: two listeners, ordered identical events, '
                  'one-sided subscriptions, unread client, reconnects and UTC passed')
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
