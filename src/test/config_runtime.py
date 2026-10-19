#!/usr/bin/env python3
"""CLI/TOML precedence tests against the actual container entrypoint."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import tomllib


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    def invoke(*options, mount=None):
        command = ["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp", "-e", "HOME=/tmp"]
        if mount:
            command += ["--mount", f"type=bind,source={mount},target=/checks,readonly"]
        return subprocess.run(command + [args.image, *options], text=True, capture_output=True, timeout=30)
    result = invoke("--dump-config")
    assert result.returncode == 0, result.stderr
    config = tomllib.loads(result.stdout)
    assert config["node"]["latency-log"] == "off"
    assert config["node"]["block-peer-selection"] == "legacy"
    assert config["db"]["chain-journal"] == "wal"
    result = invoke("--dump-config", "--latency-log=off", "--block-peer-selection=latency", "--chain-db-journal=wal")
    assert result.returncode == 0, result.stderr
    config = tomllib.loads(result.stdout)
    assert config["node"]["latency-log"] == "off"
    assert config["node"]["block-peer-selection"] == "latency"
    assert config["db"]["chain-journal"] == "wal"
    with tempfile.TemporaryDirectory(prefix="warthog-config-") as temporary:
        root = Path(temporary)
        (root / "test.toml").write_text('[node]\nlatency-log="off"\nblock-peer-selection="latency"\n[db]\nchain-journal="wal"\n')
        result = invoke("--dump-config", "--config=/checks/test.toml", "--latency-log=detail", "--block-peer-selection=legacy", "--chain-db-journal=delete", mount=root)
        assert result.returncode == 0, result.stderr
        config = tomllib.loads(result.stdout)
        assert config["node"]["latency-log"] == "detail"
        assert config["node"]["block-peer-selection"] == "legacy"
        assert config["db"]["chain-journal"] == "delete"
        for key, section in [("latency-log", "node"), ("block-peer-selection", "node"), ("chain-journal", "db")]:
            (root / "invalid.toml").write_text(f'[{section}]\n{key}="invalid"\n')
            result = invoke("--test", "--config=/checks/invalid.toml", mount=root)
            assert result.returncode != 0, f"invalid TOML {key} accepted"
    for option in ("latency-log", "block-peer-selection", "chain-db-journal"):
        result = invoke("--dump-config", f"--{option}=invalid")
        assert result.returncode != 0, f"invalid CLI {option} accepted"
    print("CLI and TOML precedence/validation passed")


if __name__ == "__main__":
    main()
