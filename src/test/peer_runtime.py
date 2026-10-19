"""Private loopback P2P peers replaying genuine blocks; no invented consensus bypass."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import statistics
import struct
import subprocess
import threading
import time
import urllib.request


def frame(code, data=b""):
    body = bytes((0, code)) + data
    return struct.pack(">I", len(body)) + hashlib.sha256(body).digest()[:4] + body


def receive(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise EOFError("peer closed")
        data += chunk
    return data


def packet(sock):
    head = receive(sock, 8)
    size = struct.unpack(">I", head[:4])[0]
    if not 2 <= size <= 2_000_000:
        raise AssertionError("invalid frame size")
    body = receive(sock, size)
    if hashlib.sha256(body).digest()[:4] != head[4:8] or body[0] != 0:
        raise AssertionError("invalid frame checksum/type")
    return body[1], body[2:]


def rpc(path, payload=None, expect_error=False):
    request = urllib.request.Request("http://127.0.0.1:3000/" + path,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        value = json.load(response)
    if expect_error:
        assert value["code"] != 0, "stale local block was accepted"
        return value
    if value["code"] != 0:
        raise AssertionError(value)
    return value.get("data") if payload is not None else value["data"]


class Peer:
    def __init__(self, index, base, fixture, wire, roles, bad=None):
        self.index, self.base, self.fixture, self.wire, self.roles, self.bad = index, Path(base), fixture, wire, roles, bad
        self.height = fixture["base_height"]
        self.rows = {r[0]: (bytes.fromhex(r[1]), bytes.fromhex(r[2])) for r in fixture["blocks"]}
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.address = "127.0.0." + str(index + 1)
        self.listener.bind((self.address, 41000 + index))
        self.listener.listen(1)
        self.listener.settimeout(30)
        self.socket = None
        self.send_lock = threading.Lock()
        self.ready = threading.Event()
        self.closed = threading.Event()
        self.pinged = threading.Event()
        self.announcements = {}
        self.requests = []
        self.errors = []
        self.invalid_sent = 0
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def send(self, value):
        with self.send_lock:
            if self.socket:
                self.socket.sendall(value)

    def announce(self, index):
        self.height = self.fixture["base_height"] + index + 1
        self.send(bytes.fromhex(self.wire["steps"][index]))

    def header(self, db, height):
        if height > self.height:
            return None
        if height in self.rows:
            header = self.rows[height][0]
        elif db:
            row = db.execute("SELECT b.header FROM Consensus c JOIN Blocks b ON c.block_id=b.rowid WHERE c.height=?", (height,)).fetchone()
            header = bytes(row[0]) if row else None
        else:
            header = None
        if header and self.bad == "fork":
            changed = bytearray(header); changed[0] ^= 1; header = bytes(changed)
        return header

    def serve(self):
        db = None
        try:
            self.socket, _ = self.listener.accept()
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.socket.settimeout(40)
            greeting = receive(self.socket, 24)
            if greeting[:14] != b"WARTHOG GRUNT?":
                raise AssertionError("unexpected mainnet handshake")
            self.send(b"WARTHOG GRUNT!" + greeting[14:18] + bytes(4))
            if receive(self.socket, 1) != b"\x00":
                raise AssertionError("missing handshake ack")
            initial = bytes.fromhex(self.wire["initial"])
            if self.bad == "fork":
                # A contradictory grid (including the mainnet checkpoint) must
                # never qualify this peer to serve blocks, even with fast pings.
                initial = bytearray(initial)
                assert len(initial) > 60, "wrong-fork fixture requires checkpoint headers"
                for offset in range(60, len(initial), 80):
                    initial[offset] ^= 1
                initial = frame(0, bytes(initial[10:]))
            self.send(initial)
            if (self.base / "chain.db").exists():
                db = sqlite3.connect((self.base / "chain.db").as_uri() + "?mode=ro", uri=True)
            while True:
                code, data = packet(self.socket)
                if code == 0:
                    self.ready.set()
                elif code == 4:
                    # Both peers have fast ping replies. Actual block service time
                    # must eventually dominate a deceptively good ping average.
                    time.sleep(0.005)
                    self.send(frame(5, data[:4] + struct.pack(">HH", 0, 0)))
                    self.pinged.set()
                elif code == 6:
                    nonce, descriptor, start, count = struct.unpack(">IIIH", data)
                    headers = []
                    for height in range(start, min(start + count, self.height + 1)):
                        header = self.header(db, height)
                        if header is None:
                            break
                        headers.append(header)
                    self.send(frame(7, struct.pack(">I", nonce) + b"".join(headers)))
                elif code == 8:
                    nonce, descriptor, height = struct.unpack(">III", data)
                    header = self.header(db, height)
                    current_descriptor = struct.unpack(">I", bytes.fromhex(self.wire["initial"])[10:14])[0]
                    # With an unchanged descriptor, both the requested and the
                    # current-chain header are present in a normal probe reply.
                    self.send(frame(9, struct.pack(">IIB", nonce, current_descriptor, 3 if header else 0) + ((header or b"") * 2)))
                elif code == 10:
                    nonce, lower, upper, descriptor = struct.unpack(">IIII", data)
                    self.requests.append((lower, upper))
                    with self.roles["lock"]:
                        if self.roles["slow"] is None:
                            self.roles["slow"] = self.index
                        slow = self.roles["slow"] == self.index
                    time.sleep(0.080 if slow else 0.020)
                    bodies = [self.rows[h][1] for h in range(lower, upper + 1)]
                    if self.bad == "nonce":
                        nonce ^= 1
                        self.invalid_sent += 1
                    if self.bad == "body":
                        changed = bytearray(bodies[0]); changed[-1] ^= 1; bodies[0] = bytes(changed)
                        self.invalid_sent += 1
                    payload = struct.pack(">I", nonce) + b"".join(struct.pack(">I", len(b)) + b for b in bodies)
                    self.send(frame(11, payload))
                elif code == 2:
                    self.announcements[struct.unpack(">I", data[:4])[0]] = time.monotonic_ns()
                # No transactions, addresses, or snapshots are advertised.
        except (EOFError, ConnectionError, OSError):
            pass
        except BaseException as error:
            self.errors.append(repr(error))
        finally:
            if db:
                db.close()
            self.closed.set()

    def close(self):
        if self.socket:
            try:
                self.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.socket.close()
        self.listener.close()
        self.thread.join(timeout=3)


class Miner:
    def __init__(self, address, name):
        self.socket = socket.create_connection(("127.0.0.1", 3456), timeout=3)
        self.stream = self.socket.makefile("rb")
        self.jobs = {}
        self.errors = []
        self.condition = threading.Condition()
        self.send(1, "mining.subscribe", [])
        subscription = json.loads(self.stream.readline())
        assert subscription.get("id") == 1 and subscription.get("error") is None
        self.send(2, "mining.authorize", [address + "." + name, "x"])
        authorization = json.loads(self.stream.readline())
        assert authorization.get("id") == 2 and authorization.get("result") is True
        self.socket.settimeout(None)
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def send(self, request, method, params):
        self.socket.sendall(json.dumps({"id": request, "method": method, "params": params}).encode() + b"\n")

    def read(self):
        try:
            for line in self.stream:
                message = json.loads(line)
                if message.get("method") == "mining.notify":
                    with self.condition:
                        self.jobs[message["params"][1]] = time.monotonic_ns()
                        self.condition.notify_all()
        except (OSError, ValueError):
            pass
        except BaseException as error:
            self.errors.append(repr(error))

    def wait(self, tip, timeout=10):
        with self.condition:
            if not self.condition.wait_for(lambda: tip in self.jobs, timeout):
                raise AssertionError("miner did not receive a job for " + tip)
            return self.jobs[tip]

    def close(self):
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.thread.join(timeout=3)
        self.stream.close()
        self.socket.close()


def wait_for(function, timeout=45):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            value = function()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.01)
    raise AssertionError("runtime condition timed out")


def one_run(base, trial, fixture, wire, tools, output, policy, journal, bulk=False, bad=None, handshake_only=False, local=False):
    from run_latency_benchmarks import reset_clone
    reset_clone(base, trial)
    trial, output = Path(trial), Path(output)
    roles = {"slow": None, "lock": threading.Lock()}
    peers = [Peer(i, base, fixture, wire, roles, bad=bad if i == 0 else None)
             for i in range(1 if bad in ("nonce", "body") else 2)]
    config = trial / "probe.toml"
    config.write_text('[node]\nallow-localhost-ip=true\n')
    command = [str(Path(tools) / "wart-node"), "--chain-db=" + str(trial / "chain.db"),
               "--peers-db=" + str(trial / "peers.db"), "--config=" + str(config),
               "--connect=" + ",".join(p.address + ":" + str(41000 + p.index) for p in peers),
               "--bind=127.0.0.1:9186", "--rpc=127.0.0.1:3000", "--stratum=127.0.0.1:3456",
               "--latency-log=detail", "--block-peer-selection=" + policy, "--chain-db-journal=" + journal]
    log = output.with_suffix(".node.log").open("w")
    environment = dict(os.environ, HOME=str(trial))
    node = subprocess.Popen(command, env=environment, cwd=trial, stdout=log, stderr=subprocess.STDOUT)
    miners = []
    started = []
    received_jobs = []
    try:
        for peer in peers:
            if bad == "fork" and peer.index == 0:
                continue
            assert peer.ready.wait(45), "peer handshake failed"
            assert peer.pinged.wait(10), "missing validated ping"
        wait_for(lambda: rpc("chain/head")["height"] == fixture["base_height"])
        address = rpc("tools/wallet/new")["address"]
        # Mainnet mining is intentionally disabled before the v2 body fork.
        # Current-height RAID fixtures exercise the two real miner receivers.
        if fixture["base_height"] >= 981500:
            miners = [Miner(address, "one"), Miner(address, "two")]
        if handshake_only:
            for peer in peers:
                peer.send(frame(11, struct.pack(">II", 0x12345678, 0)))
            assert all(peer.closed.wait(10) for peer in peers), "unsolicited replies were not rejected"
            assert node.poll() is None, "node crashed rejecting an unsolicited reply"
            assert rpc("chain/head")["height"] == fixture["base_height"]
        elif bulk:
            for peer in peers:
                peer.announce(len(fixture["blocks"]) - 1)
            target = fixture["blocks"][-1][0]
            wait_for(lambda: rpc("chain/head")["height"] == target)
            for miner in miners:
                miner.wait(wire["tip_hashes"][-1])
            assert any(upper > lower for p in peers for lower, upper in p.requests), "bulk path not exercised"
        elif bad in ("nonce", "body"):
            peers[0].announce(0)
            assert peers[0].closed.wait(10), "invalid reply did not disconnect its peer"
            assert peers[0].invalid_sent, "invalid nonce/body scenario was not exercised"
            assert node.poll() is None, "node crashed while rejecting invalid peer"
            assert rpc("chain/head")["height"] == fixture["base_height"], "invalid block changed canonical state"
        else:
            for index, row in enumerate(fixture["blocks"]):
                started.append(time.monotonic_ns())
                if local:
                    rpc("chain/append", {"height": row[0], "header": row[1], "body": row[2]})
                else:
                    for peer in peers:
                        if bad == "fork" and peer.index == 0 and peer.closed.is_set():
                            continue
                        peer.announce(index)
                wait_for(lambda: rpc("chain/head")["height"] == row[0], timeout=15)
                jobs = [miner.wait(wire["tip_hashes"][index]) for miner in miners]
                wait_for(lambda: all(row[0] in p.announcements for p in peers if not (bad == "fork" and p.index == 0)), timeout=5)
                received_jobs.append([(job - started[-1]) // 1000 for job in jobs])
            if local:
                row = fixture["blocks"][-1]
                rpc("chain/append", {"height": row[0], "header": row[1], "body": row[2]}, expect_error=True)
                assert rpc("chain/head")["height"] == row[0]
        assert all(not peer.errors for peer in peers), [p.errors for p in peers]
        assert all(not miner.errors for miner in miners)
        if bad == "fork":
            assert not peers[0].requests, "wrong-fork peer received a block request"
    except BaseException:
        print("REPLAY_PEER_DIAGNOSTICS " + json.dumps([{"errors": p.errors, "requests": p.requests[-5:], "height": p.height} for p in peers]), flush=True)
        raise
    finally:
        for miner in miners:
            miner.close()
        node.terminate()
        try:
            code = node.wait(timeout=20)
        except subprocess.TimeoutExpired:
            node.kill(); node.wait(); raise AssertionError("node did not shut down cleanly")
        for peer in peers:
            peer.close()
        log.close()
    if code:
        raise AssertionError(f"node exited with status {code}; see {log.name}")
    traces, stale = [], []
    for path in (trial / ".warthog" / "logs").glob("latency*.log"):
        for line in path.read_text().splitlines():
            if "outcome=accepted" in line and "kind=block" in line:
                traces.append(dict(re.findall(r"([a-zA-Z0-9_]+)=([^ ,\]]+)", line)))
            if "outcome=stale" in line and "kind=block" in line:
                stale.append(dict(re.findall(r"([a-zA-Z0-9_]+)=([^ ,\]]+)", line)))
    if local:
        assert len(stale) == 1 and stale[0]["hash"] == wire["tip_hashes"][-1], "stale local submission not recorded separately"
    if not bulk and bad not in ("nonce", "body") and not handshake_only:
        assert len(traces) == len(fixture["blocks"]), ("each accepted block must be counted once", len(traces))
        assert len({trace["hash"] for trace in traces}) == len(traces)
        assert {trace["hash"] for trace in traces} == set(wire["tip_hashes"]), "trace identity differs from the accepted fixture blocks"
        assert all("accept_to_peer_announcement_queued_us" in trace for trace in traces)
        if miners:
            assert all("accept_to_miner_write_queued_us" in trace for trace in traces)
    result = {"policy": policy, "journal": journal, "bulk": bulk, "invalid": bad, "local_submission": local,
              "request_us": [int(t["block_response_us"]) for t in traces if "block_response_us" in t],
              "blocks": traces,
              # Sequential endpoints, not a sum of overlapping nested spans.
              "processing_us": [int(t["submission_to_accept_us" if local else "receive_to_accept_us"]) + int(t.get("accept_to_last_miner_write_queued_us", "0")) for t in traces],
              "miner_receive_us": received_jobs,
              "peer_requests": [len(p.requests) for p in peers]}
    output.write_text(json.dumps(result, indent=2) + "\n")
    return result


def run_fork_check(base, trial, fixture_file, wire_file, tools, results):
    fixture = json.loads(Path(fixture_file).read_text())
    wire = json.loads(Path(wire_file).read_text())
    fixture["blocks"] = fixture["blocks"][:1]
    wire["steps"] = wire["steps"][:1]; wire["tip_hashes"] = wire["tip_hashes"][:1]
    value = one_run(base, trial, fixture, wire, tools, Path(results) / "wrong-fork-exclusion.json", "latency", "wal", bad="fork")
    print("WRONG_FORK_EXCLUSION " + json.dumps({"requests": value["peer_requests"], "valid_blocks": len(value["blocks"])}), flush=True)
    return value


def run_matrix(base, trial, fixture_file, wire_file, tools, results, repeats):
    fixture = json.loads(Path(fixture_file).read_text())
    wire = json.loads(Path(wire_file).read_text())
    cases = [("legacy", "delete"), ("latency", "delete"), ("latency", "wal")]
    collected = {case: [] for case in cases}
    for repeat in range(repeats):
        for policy, journal in cases[repeat % 3:] + cases[:repeat % 3]:
            output = Path(results) / f"network-{policy}-{journal}-{repeat}.json"
            value = one_run(base, trial, fixture, wire, tools, output, policy, journal)
            collected[policy, journal].append(value)
            print(f"NETWORK policy={policy} journal={journal} run={repeat+1} median_request_us={statistics.median(value['request_us'])}", flush=True)
    from run_latency_benchmarks import percentile
    median = lambda case: statistics.median(statistics.median(r["request_us"]) for r in collected[case])
    p95 = lambda case: statistics.median(percentile(r["processing_us"], 95) for r in collected[case])
    # Additional correctness scenarios are excluded from the performance samples.
    for policy in ("legacy", "latency"):
        one_run(base, trial, fixture, wire, tools, Path(results) / f"bulk-{policy}.json", policy, "wal", bulk=True)
    for invalid in ("nonce", "body"):
        one_run(base, trial, fixture, wire, tools, Path(results) / f"invalid-{invalid}.json", "latency", "wal", bad=invalid)
    one_run(base, trial, fixture, wire, tools, Path(results) / "local-found-blocks.json", "latency", "wal", local=True)
    return {"request_ratio": median(("latency", "delete")) / median(("legacy", "delete")),
            "combined_processing_p95_ratio": p95(("latency", "wal")) / p95(("legacy", "delete")),
            "valid_block_relay": True, "two_miner_receivers": fixture["base_height"] >= 981500,
            "local_found_block_submission": True,
            "bulk_and_invalid_reply_scenarios": True}
