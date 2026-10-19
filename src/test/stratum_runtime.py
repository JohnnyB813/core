"""Stratum regression probe for a disposable, isolated genesis testnet node.

Run inside the node's network namespace with Python 3; the node must have
private RPC on 127.0.0.1:3000 and Stratum on 127.0.0.1:3456. Never run this
against a production node: it generates test addresses and invalid submissions.
"""

import json
import select
import socket
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def rpc(endpoint):
    with urllib.request.urlopen("http://127.0.0.1:3000/" + endpoint, timeout=3) as response:
        result = json.load(response)
    check(result["code"] == 0, "RPC failed: " + endpoint)
    return result["data"]


class Worker:
    def __init__(self, address, name):
        self.socket = socket.create_connection(("127.0.0.1", 3456), timeout=3)
        self.socket.settimeout(2)
        self.buffer = b""
        self.send(1, "mining.subscribe", [])
        subscription = self.read()
        check(subscription["id"] == 1 and subscription["error"] is None,
              "Subscription failed")
        self.prefix = subscription["result"][1]
        self.send(2, "mining.authorize", [address + "." + name, "x"])
        authorization = self.read()
        check(authorization.get("id") == 2 and authorization.get("result") is True,
              "Authorization reply did not precede the job")

    def send(self, request_id, method, params):
        self.socket.sendall(json.dumps({"id": request_id, "method": method,
                                       "params": params}).encode() + b"\n")

    def read(self):
        while b"\n" not in self.buffer:
            chunk = self.socket.recv(65536)
            check(bool(chunk), "Unexpected Stratum disconnect")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def job(self):
        difficulty = self.read()
        notification = self.read()
        check(difficulty.get("method") == "mining.set_difficulty",
              "Difficulty did not precede the job")
        check(notification.get("method") == "mining.notify", "Missing mining job")
        check(notification["params"][-1] is True, "First job must be clean")
        return difficulty, notification

    def quiet(self):
        check(not self.buffer and not select.select([self.socket], [], [], 0.05)[0],
              "Unexpected duplicate job or response")

    def close(self):
        self.socket.close()


for attempt in range(100):
    try:
        initial_head = rpc("chain/head")
        break
    except OSError:
        time.sleep(0.1)
else:
    raise AssertionError("Test node did not start")

check(initial_head["height"] == 0, "Probe requires a disposable genesis testnet")
address = rpc("tools/wallet/new")["address"]
other_address = rpc("tools/wallet/new")["address"]
workers = []
try:
    anchor = Worker(address, "anchor")
    workers.append(anchor)
    original_job = anchor.job()
    prefixes = {anchor.prefix}

    started = time.perf_counter()
    second = Worker(address, "second")
    workers.append(second)
    try:
        check(second.job() == original_job, "Same-address worker received a different template")
    except TimeoutError as error:
        raise AssertionError("Second same-address worker authorized but received no job") from error
    second_job_ms = (time.perf_counter() - started) * 1000
    check(second.prefix not in prefixes, "Workers shared an extranonce prefix")
    prefixes.add(second.prefix)
    anchor.quiet()

    # Real chain validation must still reject the submitted timestamp of zero.
    second.send(3, "mining.submit", [original_job[1]["params"][0],
                                    "010203040506", "00000000", "00000000"])
    rejection = second.read()
    check(rejection["id"] == 3 and rejection["error"][0] == 40,
          "Invalid submission did not reach normal chain validation")

    second.send(4, "mining.submit", ["unknown-job", "000000000000",
                                    "00000000", "00000000"])
    unknown = second.read()
    check(unknown["id"] == 4 and unknown["error"][0] == 21,
          "Unknown job was not rejected")

    # Each reconnect must get the current, unmodified template immediately.
    second.close()
    workers.remove(second)
    for index in range(12):
        worker = Worker(address, "reconnect-" + str(index))
        workers.append(worker)
        check(worker.job() == original_job, "Reconnect received a stale or modified template")
        check(worker.prefix not in prefixes, "Reconnect reused an extranonce prefix")
        prefixes.add(worker.prefix)
        worker.quiet()
        worker.close()
        workers.remove(worker)

    other = Worker(other_address, "other-address")
    workers.append(other)
    other_job = other.job()
    check(other_job[1]["params"][1] == original_job[1]["params"][1],
          "Distinct-address worker received a different chain tip")

    # Reauthorization must replace one registration, including when the payout
    # address stays the same. Closing the worker must leave no dangling entries.
    reauthorized = Worker(address, "reauthorize")
    workers.append(reauthorized)
    check(reauthorized.job() == original_job, "Reauthorization worker got wrong initial job")
    reauthorized.send(5, "mining.authorize", [address + ".renamed", "x"])
    reply = reauthorized.read()
    check(reply.get("id") == 5 and reply.get("result") is True, "Same-address reauthorization failed")
    check(reauthorized.job() == original_job, "Same-address reauthorization changed the template")
    reauthorized.quiet()
    reauthorized.close()
    workers.remove(reauthorized)
    reauthorized = Worker(address, "change-payout")
    workers.append(reauthorized)
    check(reauthorized.job() == original_job, "Payout-change worker got wrong initial job")
    reauthorized.send(6, "mining.authorize", [other_address + ".moved", "x"])
    reply = reauthorized.read()
    check(reply.get("id") == 6 and reply.get("result") is True, "Payout-address change failed")
    check(reauthorized.job() == other_job, "Payout-address change used the old template")
    reauthorized.quiet()
    reauthorized.close()
    workers.remove(reauthorized)
    anchor.quiet()
    other.quiet()

    # A result may reach the Stratum loop after its submitting socket closes.
    for index in range(24):
        disconnected = Worker(address, "submit-disconnect-" + str(index))
        workers.append(disconnected)
        disconnected_job = disconnected.job()
        disconnected.send(7, "mining.submit", [disconnected_job[1]["params"][0],
                                               "010203040506", "00000000", "00000000"])
        disconnected.close()
        workers.remove(disconnected)
    check(rpc("chain/head") == initial_head, "Disconnected submissions changed the chain")

    # Both endpoints join responses from the chain and eventloop worker threads.
    paths = ["chain/head", "chain/mine/" + address] * 64
    with ThreadPoolExecutor(max_workers=8) as executor:
        for path, result in zip(paths, executor.map(rpc, paths)):
            check(result["height"] == (0 if path == "chain/head" else 1),
                  "Concurrent API response has wrong height")
            check(isinstance(result["synced"], bool), "Concurrent API response lacks sync state")

    anchor.close()
    workers.remove(anchor)
    restarted = Worker(address, "after-last-disconnect")
    workers.append(restarted)
    # A new subscription may regenerate the timestamp and job ID. Its tip,
    # payout prefix, version, target, and difficulty must remain correct.
    restarted_job = restarted.job()
    check(restarted_job[0] == original_job[0]
          and restarted_job[1]["params"][1:5] == original_job[1]["params"][1:5],
          "Resubscription changed the chain tip or payout template")
    restarted.quiet()
    check(rpc("chain/head") == initial_head, "Invalid submission changed the chain")

    print(json.dumps({"same_address_worker": "pass", "authorization_order": "pass",
                      "difficulty_job_order": "pass", "reconnects": 12,
                      "unique_extranonce_prefixes": "pass", "template_preservation": "pass",
                      "invalid_submission_rejected": "pass", "unknown_job_rejected": "pass",
                      "distinct_address_worker": "pass", "resubscription": "pass",
                      "same_address_reauthorization": "pass", "payout_address_change": "pass",
                      "submit_disconnects": 24,
                      "concurrent_head_and_mining_requests": len(paths),
                      "second_worker_job_ms": round(second_job_ms, 3),
                      "scope": "isolated genesis testnet; no valid block or mainnet relay benchmark"}))
finally:
    for worker in workers:
        worker.close()
