"""Exercise real Warthog SQLite files across restart and recreation.

Only uniquely named, labeled containers and volumes created by this script are
modified. All test containers have --network=none and no host path mounts.
The additional SQLite table exists only in these disposable local fixtures.
"""

import argparse
import json
import re
import subprocess
import time
import uuid
from pathlib import Path

HELPER = "python:3.14-alpine3.23@sha256:f6a7dec95e6205059dccfcb07faca3ca38729ea35df01231caf1d127bacedec8"
LABEL = "codex.evernode-storage-test"
DATA = "/warthog/.warthog"


def docker(*args, check=True):
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=120
    )
    if check and result.returncode:
        raise RuntimeError(f"docker {args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def inspect_owned(kind, name, run_id):
    obj = json.loads(docker(kind, "inspect", name))[0]
    labels = obj.get("Config", {}).get("Labels", {}) if kind == "container" else obj.get("Labels", {})
    if labels.get(LABEL) != run_id:
        raise RuntimeError(f"refusing to modify an unowned {kind}: {name}")
    return obj


def probe(container, operation, value):
    program = """
import json, pathlib, sqlite3, sys
p = pathlib.Path('/warthog/.warthog')
db = p / 'chain.db3'
out = {'volume_id': (p / '.evernode-volume-id').read_text().strip(),
       'starts': int((p / '.evernode-start-count').read_text()),
       'chain_bytes': db.stat().st_size}
c = sqlite3.connect(db)
if sys.argv[1] == 'seed':
    c.execute('CREATE TABLE codex_test_probe (value TEXT NOT NULL)')
    c.execute('INSERT INTO codex_test_probe VALUES (?)', (sys.argv[2],))
    c.commit()
tables = c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_test_probe'").fetchall()
out['probe_values'] = [r[0] for r in c.execute('SELECT value FROM codex_test_probe')] if tables else []
out['quick_check'] = c.execute('PRAGMA quick_check').fetchone()[0]
c.close()
print(json.dumps(out))
"""
    return json.loads(docker(
        "run", "--rm", "--network=none", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--volumes-from", container,
        HELPER, "python", "-c", program, operation, value,
    ))


def await_start(container, minimum_counter=1):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        logs = docker("logs", container)
        markers = re.findall(r"\[evr\] data_dir=.*", logs)
        latest_start = logs[logs.rfind("[evr] data_dir="):]
        if markers and "RPC public endpoint is 0.0.0.0:3001." in latest_start:
            latest = markers[-1]
            count = int(re.search(r"starts=(\d+)", latest).group(1))
            if count >= minimum_counter:
                return latest
        time.sleep(0.2)
    raise RuntimeError("Warthog did not start its public API within 30 seconds")


def scenario(image, run_id, exact):
    suffix = "exact" if exact else "parent"
    name = f"codex-evr-storage-{run_id}-{suffix}"
    volume = name + "-data"
    target = DATA if exact else "/warthog"
    value = uuid.uuid4().hex
    exists = json.loads(docker("container", "inspect", name, check=False) or "[]")
    existing_volume = json.loads(docker("volume", "inspect", volume, check=False) or "[]")
    if exists or existing_volume:
        raise RuntimeError("test resource name already exists")
    docker("volume", "create", "--label", f"{LABEL}={run_id}", volume)
    created = False
    try:
        def create():
            nonlocal created
            docker(
                "run", "-d", "--name", name, "--label", f"{LABEL}={run_id}",
                "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--mount", f"type=volume,source={volume},target={target}", image,
            )
            created = True
            obj = inspect_owned("container", name, run_id)
            return [{k: m.get(k) for k in ("Type", "Name", "Destination")}
                    for m in obj["Mounts"]]

        mounts = create()
        first_log = await_start(name)
        assert "mode=isolated" in first_log and "restored=0" in first_log
        docker("stop", "--time=10", name)
        before = probe(name, "seed", value)
        assert before["quick_check"] == "ok"
        # Starting the same container after a clean stop retains both mount forms.
        docker("start", name)
        restart_log = await_start(name, 2)
        docker("stop", "--time=10", name)
        after_restart = probe(name, "read", value)
        assert after_restart["probe_values"] == [value]
        assert after_restart["volume_id"] == before["volume_id"]
        assert "mode=network" in restart_log
        inspect_owned("container", name, run_id)
        docker("rm", "-v", name)
        created = False
        recreated_mounts = create()
        recreated_log = await_start(name, 3 if exact else 1)
        docker("stop", "--time=10", name)
        after_recreate = probe(name, "read", value)
        retained = after_recreate["probe_values"] == [value]
        assert retained == exact
        assert (after_recreate["volume_id"] == before["volume_id"]) == exact
        assert after_recreate["quick_check"] == "ok"
        assert ("mode=network" in recreated_log) == exact
        return {
            "requested_mount": target, "mounts": mounts,
            "recreated_mounts": recreated_mounts,
            "first_start": first_log, "restart_start": restart_log,
            "recreated_start": recreated_log,
            "retained_on_same_container_restart": True,
            "retained_on_recreation": retained,
            "sqlite_quick_check": after_recreate["quick_check"],
        }
    finally:
        if created:
            inspect_owned("container", name, run_id)
            docker("rm", "-f", "-v", name)
        inspect_owned("volume", volume, run_id)
        docker("volume", "rm", volume)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run_id = uuid.uuid4().hex[:10]
    result = {
        "image": args.image, "run_id": run_id,
        "scope": "new local Docker fixtures; no Evernode or existing-container changes",
        "parent_mount": scenario(args.image, run_id, False),
        "exact_mount": scenario(args.image, run_id, True),
    }
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
