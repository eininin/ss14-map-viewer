#!/usr/bin/env python3
"""Index every map of one fork for the Browse maps window.

usage: map_index.py <Resources dir> <fork id> <repo> <commit> <out dir>

writes  <out>/maps-<fork>.json   one row per map: name, path, category, file size, tiles,
                                 width x height, entities, grids, official data (shipyard
                                 vessel: price, size, shipyard group, classes, engines;
                                 station: player counts)
        <out>/items-<fork>.json  which maps contain which prototype (for "contains item")

The maps are scanned as text (fast), not fully parsed.
"""
import base64, json, os, re, struct, sys
sys.path.insert(0, os.path.dirname(__file__))
from build_db import load_all

DEV = {"test", "tests", "debug", "dev", "testing"}
SHUTTLE = {"shuttles", "shuttle", "shuttleevent", "drones", "ships", "adminspawn"}
DUNGEON = {"dungeon", "dungeons", "ruins", "salvage", "lavaland", "bluespace", "templates", "randommap",
           "expedition", "expeditions", "asteroids", "wrecks"}
STATION = {"stations", "poi", "outpost", "outposts"}


def category(rel, station_paths, vessel_paths):
    p = rel.lower()
    segs = [s for s in p.split("/")[:-1] if not s.startswith("_")]
    name = p.split("/")[-1]
    if any(s in DEV for s in segs) or name.startswith(("test", "dev_map", "dev.")) or "/test/" in p:
        return "dev"
    if "/" + rel in vessel_paths or any(s in SHUTTLE for s in segs):
        return "shuttle"
    if any(s in DUNGEON for s in segs):
        return "dungeon"
    if "/" + rel in station_paths or any(s in STATION for s in segs) or "/" not in rel:
        return "station"
    return "misc"


PROTO_RE = re.compile(r"^- proto: ?(.*)$")
UID_RE = re.compile(r"^  - uid: ")
TILEMAP_RE = re.compile(r"^  (-?\d+): (\S+)\s*$")
TILES_RE = re.compile(r"^\s+tiles: (\S+)\s*$")
IND_RE = re.compile(r"^\s+ind: (-?\d+),(-?\d+)\s*$")
VER_RE = re.compile(r"^\s+version: (\d+)\s*$")
NAME_RE = re.compile(r"^\s+name: (.+)$")


def scan(path):
    tilemap = {}
    protos = {}
    ents = 0
    grids = 0
    gname = None
    tiles = 0
    x0 = y0 = 10 ** 9
    x1 = y1 = -10 ** 9
    cur = None
    section = None
    ind = None
    with open(path, encoding="utf-8-sig", errors="replace") as fh:
        for line in fh:
            if not line.startswith(" ") and not line.startswith("-"):
                section = line.split(":")[0].strip()
                continue
            if section == "tilemap":
                m = TILEMAP_RE.match(line)
                if m:
                    tilemap[int(m.group(1))] = m.group(2).strip("'\"")
                continue
            if section != "entities":
                continue
            m = PROTO_RE.match(line)
            if m:
                cur = m.group(1).strip().strip("'\"")
                continue
            if UID_RE.match(line):
                ents += 1
                if cur:
                    protos[cur] = protos.get(cur, 0) + 1
                continue
            if cur == "":
                if "- type: MapGrid" in line:
                    grids += 1
                m = NAME_RE.match(line)
                if m and gname is None and m.group(1).strip() not in ("Map Entity", "''", '""'):
                    gname = m.group(1).strip().strip("'\"")
                m = IND_RE.match(line)
                if m:
                    ind = (int(m.group(1)), int(m.group(2)))
                    continue
                m = TILES_RE.match(line)
                if m and ind is not None:
                    try:
                        b = base64.b64decode(m.group(1))
                    except Exception:
                        continue
                    n = 256
                    bpt = max(4, round(len(b) / n)) if b else 6
                    space = {k for k, v in tilemap.items() if v == "Space"}
                    for i in range(min(n, len(b) // bpt)):
                        o = i * bpt
                        tid = struct.unpack_from("<H", b, o)[0] if bpt == 4 else struct.unpack_from("<i", b, o)[0]
                        if tid in space:
                            continue
                        tiles += 1
                        tx, ty = ind[0] * 16 + i % 16, ind[1] * 16 + i // 16
                        x0 = min(x0, tx); x1 = max(x1, tx); y0 = min(y0, ty); y1 = max(y1, ty)
                    ind = None
    w = (x1 - x0 + 1) if tiles else 0
    h = (y1 - y0 + 1) if tiles else 0
    return dict(ents=ents, grids=grids, gname=gname, tiles=tiles, w=w, h=h, protos=protos)


def main():
    res, fork, repo, commit, out = sys.argv[1:6]
    docs = load_all(os.path.join(res, "Prototypes"))
    vessels, stations = {}, {}
    for d in docs:
        t = str(d.get("type"))
        if t == "vessel" and d.get("shuttlePath") and not d.get("abstract"):
            vessels[str(d["shuttlePath"]).replace("/Maps/", "/", 1)] = d
        elif t == "gameMap" and d.get("mapPath"):
            stations[str(d["mapPath"]).replace("/Maps/", "/", 1)] = d
    vessel_paths = set(vessels)
    station_paths = {p for p, d in stations.items() if p not in vessel_paths and "Shuttles" not in p}

    root = os.path.join(res, "Maps")
    rows, inverted = [], {}
    paths = sorted(os.path.relpath(os.path.join(dp, f), root).replace(os.sep, "/")
                   for dp, _, fs in os.walk(root) for f in fs if f.endswith(".yml"))
    for i, rel in enumerate(paths):
        full = os.path.join(root, rel)
        try:
            s = scan(full)
        except Exception as e:
            print("skip", rel, e, file=sys.stderr)
            continue
        key = "/" + rel
        row = {
            "p": "Maps/" + rel,
            "c": category(rel, station_paths, vessel_paths),
            "b": os.path.getsize(full),
            "e": s["ents"], "t": s["tiles"], "w": s["w"], "h": s["h"], "g": s["grids"],
        }
        v = vessels.get(key)
        gm = stations.get(key)
        name = None
        if v:
            name = v.get("name")
            o = {}
            for k_src, k in (("price", "price"), ("category", "size"), ("group", "group"), ("description", "desc")):
                if v.get(k_src) is not None:
                    o[k] = v[k_src] if k != "price" else int(v[k_src])
            for k_src, k in (("class", "class"), ("engine", "engine")):
                if isinstance(v.get(k_src), list):
                    o[k] = sorted({str(x) if str(x)[:1].isupper() else str(x).capitalize() for x in v[k_src]})
            row["v"] = o
        if gm:
            name = name or gm.get("mapName")
            o = {}
            if gm.get("minPlayers") is not None: o["min"] = int(gm["minPlayers"])
            if gm.get("maxPlayers") is not None: o["max"] = int(gm["maxPlayers"])
            if o and not v:
                row["s"] = o
        row["n"] = str(name or s["gname"] or os.path.splitext(os.path.basename(rel))[0])
        rows.append(row)
        idx = len(rows) - 1
        for proto, cnt in s["protos"].items():
            if proto:
                inverted.setdefault(proto, []).extend([idx, cnt])
        if (i + 1) % 50 == 0:
            print(f"  {fork}: {i + 1}/{len(paths)}", file=sys.stderr)

    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"maps-{fork}.json"), "w") as fh:
        json.dump({"fork": fork, "repo": repo, "commit": commit, "maps": rows}, fh, separators=(",", ":"))
    with open(os.path.join(out, f"items-{fork}.json"), "w") as fh:
        json.dump({"fork": fork, "items": inverted}, fh, separators=(",", ":"))
    cats = {}
    for r in rows:
        cats[r["c"]] = cats.get(r["c"], 0) + 1
    print(f"{fork}: {len(rows)} maps {cats}, {len(inverted)} kinds of items")


if __name__ == "__main__":
    main()
