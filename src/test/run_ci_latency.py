#!/usr/bin/env python3
"""Offline valid-block network regressions using small public mainnet fixtures."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import socket

from crash_runtime import run_crashes
from chain_recovery import run_chain_recovery
from peer_runtime import one_run
from run_latency_benchmarks import managed


def main():
    tools = Path("/tools")
    fixture = Path("/checks/fixtures/genesis-mainnet.json")
    if not fixture.is_file():
        raise RuntimeError("Missing committed public block fixture")
    artifact_dir = os.environ.get("LATENCY_ARTIFACT_DIR")
    # SQLite WAL needs a local Linux filesystem, not a Docker Desktop Windows
    # bind mount. Export diagnostics separately, including on test failure.
    with tempfile.TemporaryDirectory(prefix="wart-latency-ci-") as temporary:
      try:
        root = Path(temporary)
        base = root / "base"; base.mkdir()
        trial = managed(root / "trial")
        results = root / "results"; results.mkdir()
        env = dict(os.environ, HOME=str(trial))
        replay = results / "genesis-replay.json"
        # The replay helper has no HTTP clients. Keep its former fixed port
        # occupied to catch accidental dependence on that port returning.
        with socket.socket() as occupied_replay_port:
            occupied_replay_port.bind(("127.0.0.1", 33000))
            occupied_replay_port.listen()
            subprocess.run([str(tools / "node_replay"), str(trial), str(fixture), "wal", "summary", str(replay)], env=env, check=True)
        result = json.loads(replay.read_text())
        assert result["height"] == 100 and result["sqlite"] == "3.54.1"
        # The first 100 mainnet blocks predate the hard-coded mainnet header
        # checkpoint. Do not bypass that consensus check to make a CI peer sync.
        # Current-height valid-block relay and performance run on the RAID copy.
        wire = json.loads(Path(str(replay) + ".wire.json").read_text())
        for policy in ("legacy", "latency"):
            one_run(base, trial, json.loads(fixture.read_text()), wire, tools,
                    results / ("handshake-" + policy + ".json"), policy, "wal", handshake_only=True)
        report = {"native_mainnet_replay_blocks": 100, "handshake_ping_unsolicited_reply_policies": 2}
        one_run(base, trial, json.loads(fixture.read_text()), wire, tools,
                results / "local-found-blocks.json", "latency", "wal", local=True)
        report["local_valid_block_submissions_and_receiving_peers"] = 100
        subprocess.run(["python3", "/checks/run_stratum_submission_screen.py",
                        "--candidate", str(tools / "wart-node"),
                        "--fixture-tool", str(tools / "stratum_submit_fixture"),
                        "--results", str(root / "stratum-submissions"),
                        "--rounds", "1", "--accepted", "3", "--rejected", "40"], check=True)
        report["valid_stratum_submissions_with_two_receivers"] = 9
        report["sigkill_cases"] = run_crashes(tools / "sqlite_workload", root / "crashes")
        report["chain_recovery_cases"] = run_chain_recovery(tools / "node_replay", base, fixture,
                                                           root / "chain-recovery", result["logical_digest"])
        print("OFFLINE_LATENCY_REGRESSIONS " + json.dumps(report), flush=True)
      except Exception:
        # CI uses an ephemeral filesystem. Preserve useful failure diagnostics
        # in the Actions log before TemporaryDirectory cleans up the test data.
        logs=sorted(Path(temporary).rglob("*.log"),key=lambda p:p.stat().st_mtime)
        for path in logs[-3:]:
            print("LATENCY_REGRESSION_DIAGNOSTIC " + str(path),flush=True)
            print(path.read_text(errors="replace")[-6000:],flush=True)
        raise
      finally:
        if artifact_dir:
            shutil.copytree(temporary, Path(artifact_dir) / Path(temporary).name)


if __name__ == "__main__":
    main()
