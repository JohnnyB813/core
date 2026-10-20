"""Compare real Stratum fan-out on loopback using synthetic, never-submitted jobs.

Run inside an isolated Linux container/network namespace, not against a deployed
node. Both executables must be stratum_fanout builds with otherwise equal sources.
"""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import statistics
import tempfile
import time


PROFILES = {
    'w1-a1-t0': (1, 1, 0, 4000),
    'w1-a1-t300': (1, 1, 300, 1000),
    'w2-a1-t0': (2, 1, 0, 1000),
    'w2-a1-t300': (2, 1, 300, 500),
    'w32-a1-t300': (32, 1, 300, 250),
    'w256-a1-t0': (256, 1, 0, 250),
    'w256-a1-t300': (256, 1, 300, 250),
    'w256-a32-t300': (256, 32, 300, 250),
    'w32-a32-t300': (32, 32, 300, 250),
}


def check(value, message):
    if not value:
        raise AssertionError(message)


def sha(value):
    return hashlib.sha256(value).digest()


def template(data):
    """Independently derive the body prefix/root and notification fields."""
    header, body = bytes.fromhex(data['header']), bytes.fromhex(data['body'])
    count = int.from_bytes(body[10:12], 'big')
    offset = 12 + count * 20
    leaves = [sha(body[i:i + 20]) for i in range(12, offset, 20)]
    leaves.append(sha(body[offset:offset + 16]))
    offset += 16
    if offset < len(body):
        transfers = int.from_bytes(body[offset:offset + 4], 'big')
        offset += 4
        check(len(body) == offset + transfers * 99, 'fixture body length')
        leaves.extend(sha(body[i:i + 99]) for i in range(offset, len(body), 99))
    while len(leaves) > 2:
        leaves = [sha(b''.join(leaves[i:i + 2])) for i in range(0, len(leaves), 2)]
    prefix = b''.join(leaves)
    check(sha(prefix + body[:10]) == header[36:68], 'independent fixture Merkle root')
    target = int.from_bytes(header[32:36], 'big')
    difficulty = math.ldexp(1.0 / (target & ((1 << 22) - 1)), (target >> 22) + 22)
    return dict(data, header_bytes=header, prefix=prefix.hex(), difficulty=difficulty)


def expected(data, sequence):
    header = sequence.to_bytes(8, 'big') + data['header_bytes'][8:]
    return [
        {'id': None, 'method': 'mining.set_difficulty', 'params': [data['difficulty']]},
        {'id': None, 'method': 'mining.notify', 'params': [
            sha(sha(header)).hex(), header[:32].hex(), data['prefix'],
            header[68:72].hex(), header[32:36].hex(), header[72:76].hex(), True]},
    ]


class Worker:
    @classmethod
    async def connect(cls, port, address, payout):
        self = cls()
        self.reader, self.writer = await asyncio.open_connection('127.0.0.1', port)
        self.payout = payout
        await self.send(1, 'mining.subscribe', [])
        subscribed = await self.read()
        check(subscribed['id'] == 1 and subscribed['error'] is None, 'subscription reply')
        self.prefix = subscribed['result'][1]
        await self.send(2, 'mining.authorize', [address + '.screen', 'x'])
        authorized = await self.read()
        check(authorized.get('id') == 2 and authorized.get('result') is True,
              'authorization must precede work')
        _, pair = await self.pair()
        check(pair[0].get('method') == 'mining.set_difficulty' and
              pair[1].get('method') == 'mining.notify' and pair[1]['params'][-1] is True,
              'initial difficulty/job ordering or clean flag')
        self.initial = pair
        return self

    async def send(self, identity, method, params):
        self.writer.write(json.dumps(dict(id=identity, method=method, params=params)).encode() + b'\n')
        await self.writer.drain()

    async def read(self):
        raw = await asyncio.wait_for(self.reader.readline(), 10)
        check(raw, 'unexpected Stratum disconnect')
        return json.loads(raw)

    async def pair(self):
        difficulty = await self.reader.readline()
        notify = await self.reader.readline()
        arrived = time.monotonic_ns()
        check(difficulty and notify, 'missing complete Stratum job')
        return arrived, [json.loads(difficulty), json.loads(notify)]

    async def close(self):
        self.writer.close()
        await self.writer.wait_closed()


class Fixture:
    async def open(self, binary, payouts, transfers, log_path):
        self.temporary = tempfile.TemporaryDirectory(prefix='stratum-preparation-')
        self.log = log_path.open('wb')
        self.workers = []
        self.port = 23456
        self.process = await asyncio.create_subprocess_exec(str(binary), str(self.port),
            str(payouts), str(transfers), cwd=self.temporary.name,
            env=dict(os.environ, HOME=self.temporary.name), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=self.log, limit=32 * 1024 * 1024)
        data = await self.reply()
        check(data.get('ready') is True, 'fixture did not start')
        self.templates = [template(item) for item in data['templates']]

    async def reply(self):
        raw = await asyncio.wait_for(self.process.stdout.readline(), 15)
        check(raw, 'fixture exited before replying')
        return json.loads(raw)

    async def command(self, value):
        self.process.stdin.write(value.encode() + b'\n')
        await self.process.stdin.drain()

    async def connect(self, payout):
        data = self.templates[payout]
        worker = await Worker.connect(self.port, data['address'], payout)
        self.workers.append(worker)
        return worker

    async def dispatch(self, sequence, workers=None):
        workers = self.workers if workers is None else workers
        wanted = [expected(item, sequence) for item in self.templates]
        readers = [asyncio.create_task(worker.pair()) for worker in workers]
        await asyncio.sleep(0)  # install the receiving waits before triggering
        started = time.monotonic_ns()
        await self.command(f'job {sequence}')
        received = await asyncio.wait_for(asyncio.gather(*readers), 10)
        first, last = min(at for at, _ in received), max(at for at, _ in received)
        for worker, (_, pair) in zip(workers, received):
            check(pair == wanted[worker.payout], 'job field mismatch: ' + json.dumps(
                dict(actual=pair, expected=wanted[worker.payout])))
        return (first - started) / 1000, (last - started) / 1000

    async def close(self):
        for worker in self.workers:
            try:
                await worker.close()
            except (ConnectionError, OSError):
                pass
        if self.process.returncode is None:
            try:
                await self.command('quit')
                await asyncio.wait_for(self.process.wait(), 10)
            except (TimeoutError, ConnectionError, BrokenPipeError):
                self.process.kill()
                await self.process.wait()
        check(self.process.returncode == 0, 'fixture exited unsuccessfully; inspect its log')
        self.log.close()
        self.temporary.cleanup()


def percentile(values, fraction):
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


async def one_run(binary, profile, samples_override, warmup, log_path):
    workers, payouts, transfers, samples = PROFILES[profile]
    samples = samples_override or samples
    fixture = Fixture()
    await fixture.open(binary, payouts, transfers, log_path)
    try:
        prefixes = set()
        for i in range(workers):
            worker = await fixture.connect(i % payouts)
            check(worker.prefix not in prefixes, 'shared extranonce prefix')
            prefixes.add(worker.prefix)
        for sequence in range(1, warmup + 1):
            await fixture.dispatch(sequence)
        # A duplicate feed must not create an extra notification.
        await fixture.command(f'job {warmup}')
        await asyncio.sleep(0.002)
        if workers > payouts:
            old = fixture.workers.pop()
            await old.close()
            worker = await fixture.connect(old.payout)
            check(worker.prefix not in prefixes, 'reconnect reused an extranonce prefix')
            check(worker.initial == expected(fixture.templates[old.payout], warmup), 'cached reconnect job')
        await fixture.command('start')
        check((await fixture.reply()).get('started') is True, 'CPU measurement start')
        first, last = [], []
        for sequence in range(warmup + 1, warmup + samples + 1):
            initial, final = await fixture.dispatch(sequence)
            first.append(initial)
            last.append(final)
        await fixture.command('stop')
        usage = await fixture.reply()
        return dict(profile=profile, samples=samples, workers=workers, payouts=payouts,
            transfers=transfers, p50_us=percentile(last, .50), p95_us=percentile(last, .95),
            p99_us=percentile(last, .99), first_p95_us=percentile(first, .95), **usage)
    finally:
        await fixture.close()


async def slow_reader(binary, log_path):
    fixture = Fixture()
    await fixture.open(binary, 2, 300, log_path)
    try:
        fast = [await fixture.connect(i % 2) for i in range(8)]
        slow = await fixture.connect(0)
        await fixture.dispatch(1)
        slow.writer.get_extra_info('socket').setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        slow.writer.transport.pause_reading()
        for sequence in range(2, 502):
            await fixture.dispatch(sequence, fast)
        slow.writer.transport.resume_reading()
        for sequence in range(2, 502):
            _, pair = await asyncio.wait_for(slow.pair(), 10)
            check(pair == expected(fixture.templates[0], sequence), 'queued work changed behind slow receiver')
        return dict(fast_workers=8, payouts=2, slow_receiver_jobs=500, passed=True)
    finally:
        await fixture.close()


def summarize(runs, profile):
    selected = {variant: [r for r in runs if r['profile'] == profile and r['variant'] == variant]
                for variant in ('baseline', 'candidate')}
    result = {}
    for metric in ('p50_us', 'p95_us', 'p99_us', 'first_p95_us', 'cpu_us', 'peak_rss_kib'):
        baseline, candidate = (statistics.median(r[metric] for r in selected[v])
                               for v in ('baseline', 'candidate'))
        result[metric] = dict(baseline=baseline, candidate=candidate,
            change_percent=100 * (candidate - baseline) / baseline if baseline else None)
    baseline, candidate = result['p95_us']['baseline'], result['p95_us']['candidate']
    result['paired_p95_wins'] = sum(c['p95_us'] < b['p95_us']
        for b, c in zip(selected['baseline'], selected['candidate']))
    result['cpu_regression'] = result['cpu_us']['change_percent'] > 5
    result['latency_regression'] = candidate - baseline > max(.05 * baseline, 100)
    first = result['first_p95_us']
    result['first_latency_regression'] = first['candidate'] - first['baseline'] > max(.05 * first['baseline'], 100)
    result['benefit'] = baseline - candidate >= max(.10 * baseline, 100) and \
        result['paired_p95_wins'] >= math.ceil(.8 * len(selected['baseline']))
    return result


async def main(args):
    args.baseline = args.baseline.resolve(strict=True)
    args.candidate = args.candidate.resolve(strict=True)
    profiles = args.profiles.split(',') if args.profiles else list(PROFILES)
    check(set(profiles) <= PROFILES.keys(), 'unknown profile')
    check(args.runs >= 1 and args.warmup >= 1, 'positive repetitions and warmup required')
    check(args.jobs is None or args.jobs > 0, 'positive measured trigger count required')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    logs = args.output.parent / 'fanout-logs'
    logs.mkdir(exist_ok=True)
    report = dict(scope='isolated loopback; synthetic templates; no submissions',
        repetitions=args.runs, warmup=args.warmup, runs=[], summary={}, correctness={}, complete=False)

    def save():
        args.output.write_text(json.dumps(report, indent=2) + '\n')

    for profile in profiles:
        for repetition in range(args.runs):
            variants = ('baseline', 'candidate') if repetition % 2 == 0 else ('candidate', 'baseline')
            for variant in variants:
                result = await one_run(getattr(args, variant), profile, args.jobs, args.warmup,
                    logs / f'{profile}-{variant}-{repetition + 1}.log')
                result.update(variant=variant, repetition=repetition + 1)
                report['runs'].append(result)
                save()
                print(json.dumps(result), flush=True)
        summary = summarize(report['runs'], profile)
        report['summary'][profile] = summary
        save()
        print('PROFILE_SUMMARY ' + profile + ' ' + json.dumps(summary), flush=True)
        if any(summary[key] for key in ('cpu_regression', 'latency_regression', 'first_latency_regression')):
            report['stop_reason'] = f'{profile} failed a regression gate'
            save()
            return 2
    for variant in ('baseline', 'candidate'):
        report['correctness'][variant] = await slow_reader(getattr(args, variant), logs / f'slow-{variant}.log')
    report['complete'] = True
    report['qualified_screen'] = any(row['benefit'] for row in report['summary'].values())
    save()
    print('STRATUM_SCREEN ' + json.dumps({k: v for k, v in report.items() if k != 'runs'}), flush=True)
    return 0 if report['qualified_screen'] else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profiles')
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--jobs', type=int)
    parser.add_argument('--warmup', type=int, default=20)
    raise SystemExit(asyncio.run(main(parser.parse_args())))
