#!/usr/bin/env python3
"""Attribute stage body readback before attempting a production handoff."""
import argparse
import json
import math
from pathlib import Path
import statistics
import subprocess


def percentile(values, p=95):
    return sorted(values)[max(0, math.ceil(len(values) * p / 100) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    binary = Path(args.binary).resolve(strict=True)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"complete": False, "runs": [], "scope": "optimistic component upper bound, not a production candidate"}
    profiles = [(0, 2000), (100, 512), (353, 256)]
    for repeat in range(5):
        for transfers, iterations in profiles[repeat % len(profiles):] + profiles[:repeat % len(profiles)]:
            process = subprocess.run([str(binary), str(transfers), str(iterations)], capture_output=True, text=True)
            if process.returncode:
                raise RuntimeError(f"Profile failed ({process.returncode}): {process.stdout[-2000:]} {process.stderr[-2000:]}")
            value = json.loads(next(s for s in process.stdout.splitlines() if s.startswith('{')))
            assert value["signature_count_checked"], "Linux signature-count wrapper required for this screen"
            value["run"] = repeat + 1
            result["runs"].append(value)
            output.write_text(json.dumps(result, indent=2) + "\n")
            print("APPLICATION_PROFILE", repeat + 1, transfers,
                  {label: {"total_p95_us": percentile([s["total_us"] for s in samples]),
                           "readback_median_us": statistics.median(s["readback_us"] for s in samples)}
                   for label, samples in value["samples"].items()}, flush=True)
    summary = {}
    for transfers, iterations in profiles:
        runs = [r for r in result["runs"] if r["transfers"] == transfers]
        by_label = {}
        for label in ("readback", "direct"):
            by_label[label] = {}
            for key in ("insert_us", "readback_us", "apply_us", "total_us", "validation_us", "state_write_us", "cpu_us"):
                by_label[label][key + "_median"] = statistics.median(
                    statistics.median(s[key] for s in r["samples"][label]) for r in runs)
                by_label[label][key + "_p95"] = statistics.median(
                    percentile([s[key] for s in r["samples"][label]]) for r in runs)
        baseline = by_label["readback"]["total_us_p95"]
        direct = by_label["direct"]["total_us_p95"]
        wins = sum(percentile([s["total_us"] for s in r["samples"]["direct"]])
                   < percentile([s["total_us"] for s in r["samples"]["readback"]]) for r in runs)
        summary[str(transfers)] = {"body_bytes": runs[0]["body_bytes"], "metrics": by_label,
            "p95_pair_wins": wins, "p95_change_percent": 100 * (direct / baseline - 1),
            "optimistic_benefit_gate": baseline - direct >= max(100, baseline * .10) and wins >= 4,
            "readback_fraction_of_median_percent": 100 * by_label["readback"]["readback_us_median"]
                / by_label["readback"]["total_us_median"],
            "max_peak_rss_kib": max(r["peak_rss_kib"] for r in runs)}
    result.update(complete=True, summary=summary)
    output.write_text(json.dumps(result, indent=2) + "\n")
    print("APPLICATION_SUMMARY", json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
