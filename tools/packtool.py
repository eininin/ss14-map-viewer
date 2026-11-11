#!/usr/bin/env python3
"""Sprite pack helper.

  packtool.py index <pack folder>...
      write <pack>/index.json listing every file (the viewer uses it to skip
      requests for files a pack doesn't have)

  packtool.py gitdiff <fork checkout> <out pack folder> --base <checkout>... [--list]
      same idea, but compares git blob hashes (whole files), so no textures need downloading
      to decide; with --list it prints the paths to check out first

  packtool.py diff <Textures of the fork> <out pack folder> --base <Textures>...
      make a pack holding only what the base packs don't already have:
      whole RSIs that are missing, single states missing from an RSI that
      exists (meta.json is rewritten to list just those states), and plain
      .png textures (tiles etc.). Example – Hardlight minus Starlight:

        packtool.py diff hardlight/Resources/Textures packs/hardlight \\
            --base starlight/Resources/Textures
"""
import argparse, json, os, re, shutil, sys

# folders that never appear on a map (lobby art, parallax backgrounds)
SKIP_DIRS = re.compile(r"(^|/)(Lobby|LobbyScreens|Parallaxes|Parallax|Logo|Credits)(/|$)", re.I)


def read_meta(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except Exception:
        return None


def index(pack):
    """index.json lists the .rsi folders (whose meta.json says which states exist)
    and every other file, so the viewer never asks for files that aren't there."""
    rsis, files = [], []
    for dp, dns, fs in os.walk(pack):
        dns.sort()
        rel_dir = os.path.relpath(dp, pack).replace(os.sep, "/")
        if rel_dir.endswith(".rsi"):
            rsis.append(rel_dir)
            dns[:] = []
            continue
        for f in sorted(fs):
            rel = f if rel_dir == "." else rel_dir + "/" + f
            if rel in ("index.json", "README.md"):
                continue
            files.append(rel)
    name = os.path.basename(os.path.normpath(pack))
    old = read_meta(os.path.join(pack, "index.json")) or {}
    with open(os.path.join(pack, "index.json"), "w") as fh:
        json.dump({"name": old.get("name", name), "rsis": rsis, "files": files}, fh, separators=(",", ":"))
        fh.write("\n")
    print(f"{pack}: {len(rsis)} RSIs, {len(files)} other files")


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
        if SKIP_DIRS.search(rel_dir):
            dns[:] = []
            continue
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


def git_blobs(repo, prefix="Resources/Textures"):
    """path -> blob hash for every file under prefix, from the git tree (no file downloads needed)"""
    import subprocess
    out = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "HEAD", prefix], capture_output=True, text=True, check=True).stdout
    res = {}
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        res[path[len(prefix) + 1:]] = meta.split()[2]
    return res


def gitdiff(fork, out, bases, list_only):
    """Files of `fork` that differ from what the base packs (in viewer order) would serve.
    A path is kept when no base has it, or the first base that has it holds different content.
    Every meta.json of an RSI with kept files is kept too. With list_only, only print the paths."""
    mine = git_blobs(fork)
    base_maps = [git_blobs(b) for b in bases]
    keep = []
    for path, sha in mine.items():
        if SKIP_DIRS.search(path) or not path.lower().endswith((".png", ".json")):
            continue
        for bm in base_maps:
            if path in bm:
                if bm[path] != sha:
                    keep.append(path)
                break
        else:
            keep.append(path)
    rsis = {p[:p.lower().index(".rsi/") + 4] for p in keep if ".rsi/" in p.lower()}
    for r in rsis:
        m = r + "/meta.json"
        if m in mine and m not in keep:
            keep.append(m)
    keep.sort()
    if list_only:
        for p in keep:
            print("/Resources/Textures/" + p)
        return
    shutil.rmtree(out, ignore_errors=True)
    for p in keep:
        src = os.path.join(fork, "Resources", "Textures", p)
        if not os.path.exists(src):
            print("missing (not checked out):", p, file=sys.stderr)
            continue
        os.makedirs(os.path.join(out, os.path.dirname(p)), exist_ok=True)
        shutil.copy2(src, os.path.join(out, p))
    # exact file list: a diff pack must not claim whole RSIs
    with open(os.path.join(out, "index.json"), "w") as fh:
        json.dump({"name": os.path.basename(os.path.normpath(out)), "exact": True, "rsis": [], "files": keep}, fh, separators=(",", ":"))
    print(f"{out}: {len(keep)} files differ from {', '.join(os.path.basename(b) for b in bases)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("index"); a1.add_argument("packs", nargs="+")
    a2 = sub.add_parser("diff"); a2.add_argument("src"); a2.add_argument("out")
    a2.add_argument("--base", nargs="+", required=True)
    a3 = sub.add_parser("gitdiff", help="files of a fork checkout that differ from base checkouts (by git hash)")
    a3.add_argument("fork"); a3.add_argument("out"); a3.add_argument("--base", nargs="+", required=True)
    a3.add_argument("--list", action="store_true", help="only print the paths to check out")
    a = ap.parse_args()
    if a.cmd == "index":
        for p in a.packs:
            if os.path.isdir(p) and not (read_meta(os.path.join(p, "index.json")) or {}).get("exact"):
                index(p)
    elif a.cmd == "gitdiff":
        gitdiff(a.fork, a.out, a.base, a.list)
    else:
        diff(a.src, a.out, a.base)


if __name__ == "__main__":
    main()
