#!/usr/bin/env python3
"""Sprite pack helper.

  packtool.py index <pack folder>...
      write <pack>/index.json listing every file (the viewer uses it to skip
      requests for files a pack doesn't have)

  packtool.py diff <Textures of the fork> <out pack folder> --base <Textures>...
      make a pack holding only what the base packs don't already have:
      whole RSIs that are missing, single states missing from an RSI that
      exists (meta.json is rewritten to list just those states), and plain
      .png textures (tiles etc.). Example – Hardlight minus Starlight:

        packtool.py diff hardlight/Resources/Textures packs/hardlight \\
            --base starlight/Resources/Textures
"""
import argparse, json, os, shutil, sys


def read_meta(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except Exception:
        return None


def index(pack):
    files = []
    for dp, dns, fs in os.walk(pack):
        dns.sort()
        for f in sorted(fs):
            rel = os.path.relpath(os.path.join(dp, f), pack).replace(os.sep, "/")
            if rel in ("index.json", "README.md"):
                continue
            files.append(rel)
    name = os.path.basename(os.path.normpath(pack))
    old = read_meta(os.path.join(pack, "index.json")) or {}
    with open(os.path.join(pack, "index.json"), "w") as fh:
        json.dump({"name": old.get("name", name), "files": files}, fh, separators=(",", ":"))
        fh.write("\n")
    print(f"{pack}: {len(files)} files")


def diff(src, out, bases):
    def base_states(rsi_rel):
        have = set()
        found = False
        for b in bases:
            m = read_meta(os.path.join(b, rsi_rel, "meta.json"))
            if m:
                found = True
                have.update(str(s.get("name")) for s in m.get("states", []))
        return found, have

    n_rsi = n_states = n_tex = 0
    for dp, dns, fs in os.walk(src):
        rel_dir = os.path.relpath(dp, src).replace(os.sep, "/")
        if rel_dir.endswith(".rsi"):
            dns[:] = []
            meta = read_meta(os.path.join(dp, "meta.json"))
            if not meta:
                continue
            found, have = base_states(rel_dir)
            keep = [s for s in meta.get("states", []) if str(s.get("name")) not in have]
            if not keep:
                continue
            dst = os.path.join(out, rel_dir)
            os.makedirs(dst, exist_ok=True)
            m2 = dict(meta)
            m2["states"] = keep
            with open(os.path.join(dst, "meta.json"), "w") as fh:
                json.dump(m2, fh, indent=2)
            for s in keep:
                p = os.path.join(dp, str(s.get("name")) + ".png")
                if os.path.exists(p):
                    shutil.copy2(p, dst)
            n_rsi += 0 if found else 1
            n_states += len(keep)
            continue
        if ".rsi/" in rel_dir + "/":
            continue
        for f in fs:
            if not f.lower().endswith(".png"):
                continue
            rel = (rel_dir + "/" + f) if rel_dir != "." else f
            if any(os.path.exists(os.path.join(b, rel)) for b in bases):
                continue
            os.makedirs(os.path.join(out, os.path.dirname(rel)), exist_ok=True)
            shutil.copy2(os.path.join(dp, f), os.path.join(out, rel))
            n_tex += 1
    print(f"{out}: {n_rsi} new RSIs, {n_states} states, {n_tex} textures")
    index(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("index"); a1.add_argument("packs", nargs="+")
    a2 = sub.add_parser("diff"); a2.add_argument("src"); a2.add_argument("out")
    a2.add_argument("--base", nargs="+", required=True)
    a = ap.parse_args()
    if a.cmd == "index":
        for p in a.packs:
            if os.path.isdir(p):
                index(p)
    else:
        diff(a.src, a.out, a.base)


if __name__ == "__main__":
    main()
