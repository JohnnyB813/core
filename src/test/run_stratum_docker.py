"""Run the Stratum probe with disposable Docker data and no external network."""

import argparse
import json
from pathlib import Path
import subprocess
import uuid


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, text=True,
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE)


def owned(resource, identity, label):
    result = docker(resource, "inspect", identity, check=False)
    if result.returncode:
        return False
    info = json.loads(result.stdout)[0]
    labels = info["Config"].get("Labels", {}) if resource == "container" else info.get("Labels", {})
    return labels.get("warthog.stratum-test") == label


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="warthog-node:stratum-candidate")
    parser.add_argument("--probe-image", default="python:3.14-slim")
    args = parser.parse_args()
    run_id = uuid.uuid4().hex
    volume = "warthog-stratum-test-" + run_id
    label = "warthog.stratum-test=" + run_id
    container = None
    volume_created = False
    tests = str(Path(__file__).resolve().parent)
    try:
        if docker("volume", "inspect", volume, check=False).returncode == 0:
            raise RuntimeError("Unexpected existing test volume")
        docker("volume", "create", "--label", label, volume)
        volume_created = True
        container = docker("create", "--network", "none", "--label", label,
                           "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                           "--workdir", "/warthog", "--mount",
                           f"type=volume,source={volume},target=/warthog/.warthog",
                           args.image, "--testnet", "--bind=127.0.0.1:9186",
                           "--rpc=127.0.0.1:3000", "--enable-public", "--stratum=127.0.0.1:3456",
                           "--connect=127.0.0.1:9187").stdout.strip()
        docker("start", container)
        result = docker("run", "--rm", "--network", "container:" + container,
                        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                        "--mount", f"type=bind,source={tests},target=/checks,readonly",
                        args.probe_image, "python3", "/checks/stratum_runtime.py", check=False)
        print(result.stdout, end="")
        if result.returncode:
            print(result.stderr, end="")
            logs = docker("logs", "--tail", "20", container, check=False)
            print(logs.stdout + logs.stderr, end="")
        return result.returncode
    finally:
        if container and owned("container", container, run_id):
            docker("stop", "--time", "10", container)
            docker("rm", container)
        if volume_created and owned("volume", volume, run_id):
            docker("volume", "rm", volume)


if __name__ == "__main__":
    raise SystemExit(main())
