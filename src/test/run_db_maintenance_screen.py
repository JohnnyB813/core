#!/usr/bin/env python3
"""Paired maintenance timings and unchanged-policy checkpoint attribution.

Helpers own newly created disposable databases. Run on a local Linux filesystem,
never a production database or a Windows bind mount for active WAL files.
"""
import argparse
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import tempfile


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p / 100) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("baseline", "candidate", "replay-baseline", "replay-candidate", "fixture", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--samples", type=int, default=20)
    args = parser.parse_args()
    if args.samples < 20:
        raise ValueError("Require at least 20 samples per run")
    baseline, candidate = Path(args.baseline).resolve(strict=True), Path(args.candidate).resolve(strict=True)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"complete": False, "runs": 5, "samples_per_run": args.samples, "maintenance": [], "replay": []}

    def save():
        output.write_text(json.dumps(result, indent=2) + "\n")

    for journal, layout, schedules in ((j, l, n) for j in ("wal", "delete")
                                     for l, n in (("contiguous", 200), ("interleaved", 200), ("contiguous", 1))):
        rows = 5000
        name = f"{journal}-{layout}-s{schedules}"
        for repeat in range(5):
            values = {"baseline": [], "candidate": []}
            # Alternate every pair and reverse first order across runs.
            for sample in range(args.samples):
                for label, binary in ((("baseline", baseline), ("candidate", candidate))
                                      if (sample + repeat) % 2 == 0 else
                                      (("candidate", candidate), ("baseline", baseline))):
                    process = subprocess.run([str(binary), "--bench", journal, layout, str(schedules), str(rows)],
                                             capture_output=True, text=True, check=True)
                    # Older helpers log their database initialization between
                    # the result prefix and JSON. Accept either complete line.
                    value = None
                    for line in process.stdout.splitlines():
                        try:
                            parsed = json.loads(line.removeprefix("MAINTENANCE_RESULT "))
                        except json.JSONDecodeError:
                            continue
                        if isinstance(parsed, dict) and "elapsed_us" in parsed:
                            value = parsed
                            break
                    assert value is not None, process.stdout
                    assert value["synchronous"] == 2 and value["sqlite"] == "3.54.1"
                    values[label].append(value)
            result["maintenance"].append({"profile": name, "run": repeat + 1, "samples": values})
            save()
            print(f"MAINTENANCE {name} run={repeat+1} " + " ".join(
                f"{label}_p95_us={percentile([x['elapsed_us'] for x in samples],95):.3f}"
                for label, samples in values.items()), flush=True)

    replay_bins = {"baseline": Path(args.replay_baseline).resolve(strict=True),
                   "candidate": Path(args.replay_candidate).resolve(strict=True)}
    expected_digest = None
    with tempfile.TemporaryDirectory(prefix="wart-db-replay-") as temporary:
        root = Path(temporary)
        for repeat in range(5):
            for label in (("baseline", "candidate") if repeat % 2 == 0 else ("candidate", "baseline")):
                directory = root / f"{label}-{repeat}"
                directory.mkdir()
                (directory / "PERF_DISPOSABLE").write_text("warthog-latency-20261018-a1\n")
                target = directory / "result.json"
                process = subprocess.run([str(replay_bins[label]), str(directory), str(Path(args.fixture).resolve()),
                                          "wal", "summary", str(target)],
                                         env=dict(os.environ, HOME=str(directory), REPLAY_CHECKPOINT_TRACE="1"),
                                         capture_output=True, text=True, check=True)
                value = json.loads(target.read_text())
                assert value["height"] == 100 and len(value["checkpoint_copies"]) == 100
                expected_digest = expected_digest or value["logical_digest"]
                assert value["logical_digest"] == expected_digest, "logical chain/state/history mismatch"
                result["replay"].append({"variant": label, "run": repeat + 1, "result": value})
                save()
                print(f"REPLAY {label} run={repeat+1} checkpoints={sum(value['checkpoint_copies'])} "
                      f"processing_p95_us={percentile(value['processing_us'],95)}", flush=True)

    summary = {}
    for name in sorted({x["profile"] for x in result["maintenance"]}):
        runs = [x for x in result["maintenance"] if x["profile"] == name]
        p95 = {label: [percentile([v["elapsed_us"] for v in r["samples"][label]], 95) for r in runs]
               for label in ("baseline", "candidate")}
        medians = {label: statistics.median(v) for label, v in p95.items()}
        cpu = {label: statistics.median(statistics.median(v["cpu_us"] for v in r["samples"][label]) for r in runs)
               for label in ("baseline", "candidate")}
        improvement = medians["baseline"] - medians["candidate"]
        wins = sum(c < b for b, c in zip(p95["baseline"], p95["candidate"]))
        summary[name] = {"median_run_p95_us": medians, "median_cpu_us": cpu, "p95_pair_wins": wins,
                         "latency_benefit": improvement >= max(100, medians["baseline"] * .10) and wins >= 4,
                         "latency_regression": -improvement > max(100, medians["baseline"] * .05),
                         "cpu_regression": cpu["candidate"] - cpu["baseline"] > max(100, cpu["baseline"] * .05)}
    replay_summary = {}
    for label in ("baseline", "candidate"):
        runs = [x["result"] for x in result["replay"] if x["variant"] == label]
        with_checkpoint, without_checkpoint = [], []
        for run in runs:
            for elapsed, copies in zip(run["commit_us"], run["checkpoint_copies"]):
                (with_checkpoint if copies else without_checkpoint).append(elapsed)
        replay_summary[label] = {
            "median_processing_p95_us": statistics.median(percentile(r["processing_us"], 95) for r in runs),
            "checkpoint_block_count": len(with_checkpoint),
            "checkpoint_block_commit_us": with_checkpoint,
            "other_block_commit_median_us": statistics.median(without_checkpoint),
            "other_block_commit_p95_us": percentile(without_checkpoint, 95)}
    result.update(complete=True, summary=summary, replay_summary=replay_summary, logical_digest=expected_digest)
    save()
    print("MAINTENANCE_SUMMARY " + json.dumps(summary), flush=True)
    print("REPLAY_SUMMARY " + json.dumps(replay_summary), flush=True)


if __name__ == "__main__":
    main()
