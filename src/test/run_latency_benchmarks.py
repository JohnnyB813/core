#!/usr/bin/env python3
"""Replay identical blocks on disposable database copies. Never mounts production RW."""
import argparse
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys

OWNER = "warthog-latency-20261018-a1"


def managed(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / "PERF_DISPOSABLE"
    if marker.exists():
        if marker.read_text().strip() != OWNER:
            raise RuntimeError(f"Foreign disposable marker: {directory}")
    elif any(directory.iterdir()):
        raise RuntimeError(f"Refusing unmarked nonempty directory: {directory}")
    marker.write_text(OWNER + "\n")
    return directory


def reset_clone(base, trial):
    base, trial = Path(base).resolve(), managed(trial)
    if base == trial or base.is_relative_to(trial) or trial.is_relative_to(base):
        raise RuntimeError("Base and trial directories must be separate")
    for child in trial.iterdir():
        if child.name == "PERF_DISPOSABLE":
            continue
        if child.is_symlink() or not child.resolve().is_relative_to(trial):
            raise RuntimeError(f"Unexpected link in disposable volume: {child}")
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    for source in base.glob("chain.db*"):
        if source.is_symlink() or not source.is_file():
            raise RuntimeError("Unexpected database source type")
        shutil.copy2(source, trial / source.name)


def run(command, log):
    with Path(log).open("w") as output:
        result = subprocess.run(list(map(str, command)), stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {command}; see {log}")


def percentile(values, p):
    values = sorted(values)
    return values[max(0, (len(values) * p + 99) // 100 - 1)]


def median_run(results, key):
    return statistics.median(statistics.median(r[key]) for r in results)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--trial", default="/trial")
    parser.add_argument("--results", default="/results")
    parser.add_argument("--tools", default="/tools")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--skip-network", action="store_true")
    args = parser.parse_args()
    base = Path(args.base).resolve()
    trial = managed(args.trial)
    results = Path(args.results).resolve()
    if results == base or results.is_relative_to(base) or results == trial or results.is_relative_to(trial):
        raise RuntimeError("Results must not be inside the base or resettable trial")
    results.mkdir(parents=True, exist_ok=True)
    fixture = json.loads(Path(args.fixture).read_text())
    if len(fixture["blocks"]) < 100:
        raise RuntimeError("Requires at least 100 recorded blocks")
    if args.runs < 5:
        raise RuntimeError("Promotion benchmarks require at least five runs")
    tools = Path(args.tools)
    cases = [
        ("old_delete_off", "node_replay_old_sqlite", "delete", "off"),
        ("new_delete_off", "node_replay", "delete", "off"),
        ("new_delete_summary", "node_replay", "delete", "summary"),
        ("new_wal_summary", "node_replay", "wal", "summary"),
    ]
    collected = {case[0]: [] for case in cases}
    expected_digest = None
    wire = None
    for repeat in range(args.runs):
        # Rotate order to reduce systematic cache/load bias.
        order = cases[repeat % len(cases):] + cases[:repeat % len(cases)]
        for name, binary, mode, diagnostics in order:
            reset_clone(base, trial)
            target = results / f"{name}-{repeat}.json"
            run([tools / binary, trial, args.fixture, mode, diagnostics, target], target.with_suffix(".log"))
            value = json.loads(target.read_text())
            if len(value["apply_us"]) != len(fixture["blocks"]):
                raise RuntimeError("Incomplete replay")
            expected_digest = expected_digest or value["logical_digest"]
            if value["logical_digest"] != expected_digest:
                raise RuntimeError(f"Logical state mismatch: {name}")
            if name.startswith("old_") and value["sqlite"] != "3.39.3":
                raise RuntimeError("Old SQLite control linked the wrong library")
            if name.startswith("new_") and value["sqlite"] != "3.54.1":
                raise RuntimeError("Candidate linked the wrong SQLite library")
            collected[name].append(value)
            wire = Path(str(target) + ".wire.json")
            print(f"REPLAY {name} run={repeat + 1} median_apply_us={statistics.median(value['apply_us'])}", flush=True)
    workload = {"old_delete": [], "new_delete": [], "new_wal": []}
    for repeat in range(args.runs):
        for name, binary, mode in [
            ("old_delete", "sqlite_workload_old", "delete"),
            ("new_delete", "sqlite_workload", "delete"),
            ("new_wal", "sqlite_workload", "wal"),
        ]:
            reset_clone(base, trial)
            target = results / f"workload-{name}-{repeat}.json"
            run([tools / binary, trial, mode, 2000, target], target.with_suffix(".log"))
            value = json.loads(target.read_text())
            workload[name].append(value)
            print(f"WORKLOAD {name} run={repeat + 1} median_commit_us={statistics.median(value['commit_us'])}", flush=True)
    baseline = statistics.median(r["replay_runtime_us"] for r in collected["new_delete_off"])
    summary = statistics.median(r["replay_runtime_us"] for r in collected["new_delete_summary"])
    delete_commit = median_run(collected["new_delete_summary"], "commit_us")
    wal_commit = median_run(collected["new_wal_summary"], "commit_us")
    # Combined local processing is compared with the old SQLite/off baseline,
    # covering the upgrade and instrumentation as well as the journal change.
    old_p95 = statistics.median(percentile(r["processing_us"], 95) for r in collected["old_delete_off"])
    new_p95 = statistics.median(percentile(r["processing_us"], 95) for r in collected["new_wal_summary"])
    report = {
        "runs": args.runs, "blocks_per_run": len(fixture["blocks"]), "logical_digest": expected_digest,
        "instrumentation_overhead_ratio": summary / baseline,
        "wal_commit_ratio": wal_commit / delete_commit,
        "processing_p95_ratio": new_p95 / old_p95,
        "gates": {"instrumentation": summary <= baseline * 1.02,
                  "wal": wal_commit <= delete_commit * 0.90,
                  "processing_p95": new_p95 <= old_p95 * 1.05},
        "workload_median_commit_us": {k: median_run(v, "commit_us") for k, v in workload.items()},
    }
    if not args.skip_network:
        from peer_runtime import run_matrix
        network = run_matrix(base, trial, args.fixture, wire, tools, results, args.runs)
        report["network"] = network
        report["gates"]["peer_selection"] = network["request_ratio"] <= 0.8
        report["gates"]["combined_p95"] = network["combined_processing_p95_ratio"] <= 1.05
    else:
        report["gates"]["peer_selection"] = False
        report["gates"]["combined_p95"] = False
    (results / "promotion.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PROMOTION_RESULT " + json.dumps(report, separators=(",", ":")), flush=True)
    # Failed performance gates retain the old defaults; correctness failures raise.
    return 0


if __name__ == "__main__":
    sys.exit(main())
