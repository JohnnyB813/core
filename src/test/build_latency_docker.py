#!/usr/bin/env python3
"""Local static build and offline runtime checks without publishing an image."""
import argparse
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder-image", default="alpine:3.23.6")
    parser.add_argument("--runtime", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    artifacts = root / "build" / "ghcr-validation"
    artifacts.mkdir(parents=True, exist_ok=True)
    context = artifacts / "bench-image"
    (context / "tools").mkdir(parents=True, exist_ok=True)
    shutil.copytree(root / "src" / "test", context / "checks", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__"))
    def run(command, log):
        print("Running: " + " ".join(map(str, command[:4])), flush=True)
        with (artifacts / log).open("w") as output:
            result = subprocess.run(list(map(str, command)), stdout=output, stderr=subprocess.STDOUT, cwd=root)
        if result.returncode:
            print((artifacts / log).read_text(errors="replace")[-8000:], flush=True)
            raise RuntimeError(f"Failed: {log}")
    script = """
if ! command -v meson >/dev/null; then apk add --no-cache meson libgcc musl-dev gcc g++ pkgconf fmt; fi
if test -f /latency-build/build.ninja; then
  meson setup --reconfigure /latency-build
else
  meson setup /latency-build --default-library static --buildtype=release
fi
meson setup --reconfigure /latency-build -Dperformance-tools=true -Dc_link_args=-static -Dcpp_link_args=-static
meson compile -C /latency-build -j 4 wart-node node_replay node_replay_old_sqlite sqlite_workload sqlite_workload_old custom_float stratum_job_cache stratum_preparation stratum_submission stratum_submit_fixture local_correctness chain_worker latency_policy journal_modes mempool_replacement mempool_reconciliation mempool_admission mempool_api_snapshot websocket_probe db_maintenance block_lookup http_payment_parsing header_verifier timer_handles
meson test -C /latency-build --no-rebuild --print-errorlogs
cp /latency-build/src/node/wart-node /latency-build/src/node/node_replay /latency-build/src/node/node_replay_old_sqlite /latency-build/src/node/stratum_submit_fixture /latency-build/src/test/sqlite_workload /latency-build/src/test/sqlite_workload_old /code/build/ghcr-validation/bench-image/tools/
"""
    run(["docker", "run", "--rm", "--label", "org.codex.warthog-perf=20261018-a1",
         "--mount", f"type=bind,source={root},target=/code",
         "--mount", "type=volume,source=warthog-latency-build-a1,target=/latency-build", "-w", "/code",
         args.builder_image, "sh", "-ec", script], "latency-tools-build.log")
    (context / "Dockerfile").write_text('FROM python:3.14-alpine3.23\nCOPY tools /tools\nCOPY checks /checks\nENV HOME=/trial\nENTRYPOINT ["python3", "/checks/run_ci_latency.py"]\n')
    run(["docker", "build", "-t", "warthog-latency-tests:local", context], "local-test-image.log")
    (context / "Node.Dockerfile").write_text('FROM scratch\nCOPY tools/wart-node /wart-node-linux\nENV HOME=/warthog\nVOLUME ["/warthog/.warthog"]\nENTRYPOINT ["/wart-node-linux", "--chain-db=/warthog/.warthog/chain.db", "--peers-db=/warthog/.warthog/peers.db"]\n')
    run(["docker", "build", "-f", context / "Node.Dockerfile", "-t", "warthog-node:latency-candidate", context], "local-node-image.log")
    if args.runtime:
        runtime = artifacts / "runtime-artifacts"; runtime.mkdir(exist_ok=True)
        run(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
             "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp", "--memory", "2g",
             "--mount", f"type=bind,source={runtime},target=/artifacts", "-e", "LATENCY_ARTIFACT_DIR=/artifacts",
             "warthog-latency-tests:local"], "offline-latency-runtime.log")
        run(["python", root / "src/test/config_runtime.py", "--image", "warthog-node:latency-candidate"], "latency-config-runtime.log")
        run(["python", root / "src/test/run_stratum_docker.py", "--image", "warthog-node:latency-candidate"], "latency-stratum-runtime.log")
    print("Local build and requested checks passed", flush=True)


if __name__ == "__main__":
    main()
