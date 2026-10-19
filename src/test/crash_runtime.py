"""Process-crash recovery of FULL commits, including checkpoint-sized workloads."""
import os
from pathlib import Path
import subprocess
import time


def run_crashes(tool, root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    count = 0
    # Each native operation dirties several pages; these cross and surround the
    # production 1000-page checkpoint interval. No power-cut claim is made.
    for mode in ("delete", "wal"):
        for target in (1, 2, 5, 30, 100, 200, 330, 331, 332, 333, 334, 335, 400, 500, 660, 661, 662, 663, 664, 665):
            directory = root / f"{mode}-{target}"
            directory.mkdir()
            (directory / "PERF_DISPOSABLE").write_text("warthog-latency-20261018-a1\n")
            ack = directory / "ack.txt"
            with (directory / "worker.log").open("w") as log:
                worker = subprocess.Popen([str(tool), str(directory), mode, "100000", str(directory / "result.json"), str(ack)], stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 45
                    acknowledged = 0
                    while time.monotonic() < deadline:
                        if worker.poll() is not None:
                            raise AssertionError("crash workload exited early")
                        if ack.exists():
                            lines = ack.read_bytes().split(b"\n")[:-1]
                            acknowledged = int(lines[-1]) if lines else 0
                            if acknowledged >= target:
                                break
                        time.sleep(0.002)
                    else:
                        raise AssertionError("crash workload did not commit")
                    worker.kill()
                    worker.wait(timeout=10)
                finally:
                    if worker.poll() is None:
                        worker.kill(); worker.wait(timeout=10)
            subprocess.run([str(tool), "--verify", str(directory), str(acknowledged)], check=True)
            count += 1
    print(f"SIGKILL recovery cases={count}; FULL commits and integrity preserved (not a power-cut test)", flush=True)
    return count
