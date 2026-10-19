"""Recover real chain/state/history after process kills and SQLite VFS errors."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

from run_latency_benchmarks import managed, reset_clone


def run_chain_recovery(tool, base, fixture_file, root, expected_digest):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    fixture = json.loads(Path(fixture_file).read_text())
    cases = [(mode, kind, n) for mode in ("delete", "wal")
             for kind, points in (("kill", (1, 10, 49, 90, 99)),
                                  ("write", (1, 5, 20)), ("partial", (1, 5, 20)), ("sync", (1, 5, 20)))
             for n in points]
    for index, (mode, kind, point) in enumerate(cases):
        directory = managed(root / "trial")
        reset_clone(base, directory)
        ack = directory / "ack.txt"
        output = root / f"case-{index}.json"
        environment = dict(os.environ, HOME=str(directory), REPLAY_ACK=str(ack))
        if kind == "kill":
            environment["REPLAY_PAUSE_US"] = "10000"
        else:
            environment["REPLAY_IO_FAILURE"] = kind + ":" + str(point)
        acknowledged = fixture["base_height"]
        with output.with_suffix(".log").open("w") as log:
            worker = subprocess.Popen([str(tool), str(directory), str(fixture_file), mode, "off", str(output)],
                                      stdout=log, stderr=subprocess.STDOUT, env=environment)
            try:
                if kind == "kill":
                    deadline = time.monotonic() + 45
                    while time.monotonic() < deadline:
                        if worker.poll() is not None:
                            raise AssertionError("chain crash worker exited early")
                        lines = ack.read_bytes().split(b"\n")[:-1] if ack.exists() else []
                        acknowledged = int(lines[-1]) if lines else fixture["base_height"]
                        if acknowledged >= fixture["base_height"] + point:
                            break
                        time.sleep(0.002)
                    else:
                        raise AssertionError("chain crash worker timed out")
                    worker.kill(); worker.wait(timeout=10)
                else:
                    assert worker.wait(timeout=45) != 0, "I/O fault was not exercised"
                    lines = ack.read_bytes().split(b"\n")[:-1] if ack.exists() else []
                    acknowledged = int(lines[-1]) if lines else fixture["base_height"]
            finally:
                if worker.poll() is None:
                    worker.kill(); worker.wait(timeout=10)
        # Recover with the candidate library first. Python's SQLite is used only
        # for subsequent comparison, never to perform the recovery under test.
        inspected=output.with_suffix(".recovered.json")
        subprocess.run([str(tool),"--recover",str(directory),str(inspected)],check=True)
        native=json.loads(inspected.read_text())
        assert native["sqlite"]=="3.54.1"
        # Verify all acknowledged canonical blocks before resuming consensus.
        with sqlite3.connect(directory / "chain.db") as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            recovered = db.execute("SELECT coalesce(max(height),0) FROM Consensus WHERE height>0").fetchone()[0]
            assert recovered==native["height"]
            assert recovered >= acknowledged
            for height, header, body in fixture["blocks"]:
                if height > recovered:
                    break
                row = db.execute("SELECT b.header,b.body FROM Consensus c JOIN Blocks b ON c.block_id=b.rowid WHERE c.height=?", (height,)).fetchone()
                assert row == (bytes.fromhex(header), bytes.fromhex(body))
        remaining = dict(fixture, base_height=recovered, blocks=[r for r in fixture["blocks"] if r[0] > recovered])
        resumed = root / "resume.json"; resumed.write_text(json.dumps(remaining))
        with output.with_suffix(".recovery.log").open("w") as log:
            subprocess.run([str(tool), str(directory), str(resumed), mode, "off", str(output)],
                           stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, HOME=str(directory)), check=True)
        result = json.loads(output.read_text())
        assert result["logical_digest"] == expected_digest, (mode, kind, point, "chain/state/history mismatch")
    print(f"CHAIN_RECOVERY cases={len(cases)} logical chain/state/history equivalent; SIGKILL is not a power-cut test", flush=True)
    return len(cases)
