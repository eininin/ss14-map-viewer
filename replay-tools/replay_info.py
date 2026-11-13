#!/usr/bin/env python3
"""Print the build info of an SS14 replay zip (from _replay/replay.yml and replay_final.yml).

Usage: replay_info.py <replay.zip> [--github-output FILE]

With --github-output, also appends key=value lines for a GitHub Actions step.
"""
import re
import sys
import zipfile


def read_yaml_keys(zf, name):
    try:
        text = zf.read(name).decode("utf-8", "replace")
    except KeyError:
        return {}
    keys = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z_][\w]*):[ \t]*(.*)$", line)
        if m:
            keys[m.group(1)] = m.group(2).strip().strip("'\"")
    return keys


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    out_file = None
    if "--github-output" in sys.argv:
        out_file = sys.argv[sys.argv.index("--github-output") + 1]

    with zipfile.ZipFile(path) as zf:
        meta = read_yaml_keys(zf, "_replay/replay.yml")
        final = read_yaml_keys(zf, "_replay/replay_final.yml")
        data_files = [n for n in zf.namelist() if re.match(r"^_replay/data_\d+\.dat$", n)]

    if not meta:
        print("No _replay/replay.yml in this zip - is it a replay?", file=sys.stderr)
        return 1

    info = {
        "engine_version": meta.get("engineVersion", ""),
        "fork_id": meta.get("buildForkId", ""),
        "fork_version": meta.get("buildForkVersion", ""),
        "client_recording": meta.get("isClientRecording", ""),
        "name": meta.get("name", ""),
        "duration": final.get("duration", "unknown (no replay_final.yml)"),
        "data_files": str(len(data_files)),
    }
    for k, v in info.items():
        print(f"{k}: {v}")

    if out_file:
        with open(out_file, "a") as f:
            for k, v in info.items():
                f.write(f"{k}={v}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
