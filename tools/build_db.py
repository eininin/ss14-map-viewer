#!/usr/bin/env python3
"""Build the sprite database for the SS14 map viewer from a repo checkout.

usage: build_db.py <Resources> <out.json> --repo owner/name --commit sha
                   [--extra <Resources> <repo> <commit>]...  [--maps-out maps.json]

Output (compact JSON):
  ent:   proto id -> render info (sprite, layers, drawdepth, smoothing ...)
  tile:  tile id  -> {s: texture path, v: variants}
  decal: decal id -> {s: rsi, st: state} or {t: texture}
"""
import sys, os, json, re, yaml

DRAW = {
 "LowFloors": -22, "ThickPipe": -21, "ThickWire": -20, "ThinPipeAlt4": -19, "ThinPipeAlt3": -18,
 "ThinPipeAlt2": -17, "ThinPipeAlt1": -16, "ThinPipe": -15, "ThinWire": -14, "BelowFloor": -13,
 "FloorTiles": -12, "FloorObjects": -11, "Puddles": -10, "HighFloorObjects": -5, "DeadMobs": -4,
 "SmallMobs": -3, "Walls": -2, "WallTops": -1, "Objects": 0, "SmallObjects": 1, "WallMountedItems": 2,
 "LargeObjects": 3, "Items": 4, "BelowMobs": 5, "Mobs": 6, "OverMobs": 7, "Doors": 8, "BlastDoors": 9,
 "Overdoors": 10, "Gasses": 11, "Effects": 12, "Ghosts": 13, "Overlays": 14,
}

class L(yaml.CSafeLoader if hasattr(yaml, "CSafeLoader") else yaml.SafeLoader):
    pass

class Partial(str):
    pass

def _unknown(loader, suffix, node):
    if suffix == "PartialOnly" and isinstance(node, yaml.ScalarNode):
        return Partial(loader.construct_scalar(node))
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_scalar(node)

L.add_multi_constructor("!", _unknown)

# SS14 uses YAML 1.2 rules: only true/false are booleans ("on", "off", "yes", "no" stay strings)
import re as _re
L.yaml_implicit_resolvers = {k: [(t, r) for (t, r) in v if t != "tag:yaml.org,2002:bool"]
                             for k, v in L.yaml_implicit_resolvers.copy().items()}
for ch in "tTfF":
    L.yaml_implicit_resolvers.setdefault(ch, []).insert(0, ("tag:yaml.org,2002:bool",
        _re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")))

def load_all(root):
    docs = []
    for dp, _, fs in os.walk(root):
        for f in fs:
            if not f.endswith(".yml"):
                continue
            p = os.path.join(dp, f)
            try:
                with open(p, encoding="utf-8-sig") as fh:
                    d = yaml.load(fh, Loader=L)
            except Exception as e:
                print("skip", p, e, file=sys.stderr)
                continue
            if isinstance(d, list):
                rel = os.path.relpath(p, root).replace(os.sep, "/")
                for x in d:
                    if isinstance(x, dict):
                        x["__file"] = rel
                        docs.append(x)
    return docs

def vec(v):
    if v is None:
        return None
    if isinstance(v, str):
        try:
            a = [float(x) for x in v.split(",")]
            return a if len(a) == 2 else None
        except ValueError:
            return None
    if isinstance(v, (list, tuple)) and len(v) == 2:
        return [float(v[0]), float(v[1])]
    return None

def angle(v):
    if v is None:
        return 0.0
    s = str(v).strip()
    try:
        if s.endswith("rad"):
            return float(s[:-3])
        if s.endswith("deg"):
            return float(s[:-3]) * 3.141592653589793 / 180
        return float(s) * 3.141592653589793 / 180   # bare number = degrees in RT
    except ValueError:
        return 0.0

def color(v):
    if not v:
        return None
    s = str(v).strip()
    if s.lower() in ("#ffffffff", "#ffffff", "white"):
        return None
    return s

def clean_layer(ly):
    out = {}
    if not isinstance(ly, dict):
        return None
    if ly.get("sprite"): out["s"] = str(ly["sprite"])
    if ly.get("state") is not None: out["st"] = str(ly["state"])
    if ly.get("texture"): out["t"] = str(ly["texture"])
    if ly.get("visible") is False or str(ly.get("visible")).lower() == "false": out["v"] = 0
    c = color(ly.get("color"))
    if c: out["c"] = c
    o = vec(ly.get("offset"))
    if o and (o[0] or o[1]): out["o"] = o
    sc = vec(ly.get("scale"))
    if sc and sc != [1.0, 1.0]: out["sc"] = sc
    if ly.get("rotation") is not None:
        r = angle(ly.get("rotation"))
        if r: out["r"] = r
    m = ly.get("map")
    if m:
        out["m"] = [str(x) for x in (m if isinstance(m, list) else [m])]
    if ly.get("shader"): out["sh"] = str(ly["shader"])
    return out

PIPE_DIRS = {"North": 1, "South": 2, "West": 4, "East": 8}
PIPE_NAMED = {"Longitudinal": 3, "Lateral": 12, "NWBend": 5, "NEBend": 9, "SWBend": 6, "SEBend": 10,
              "TNorth": 13, "TSouth": 14, "TWest": 7, "TEast": 11, "Fourway": 15, "All": 15}
PIPE_LAYERS = {"primary": 0, "secondary": 1, "tertiary": 2, "quaternary": 3, "quinary": 4}
DEFAULT_CONNECTORS = [[f"_Carpmosia/Structures/Piping/Atmospherics/{n}.rsi", "pipeConnector"]
                      for n in ("pipe", "pipe_alt1", "pipe_alt2", "pipe_alt3", "pipe_alt4")]


def pipe_mask(s):
    m = 0
    for part in s.replace(",", " ").split():
        m |= PIPE_DIRS.get(part, 0) | PIPE_NAMED.get(part, 0)
    return m


def pipe_layer(v):
    if v is None:
        return None
    sv = str(v).strip()
    if sv.isdigit():
        return int(sv)
    return PIPE_LAYERS.get(sv.lower())


def categorize(pid, d, comps, e):
    """Layer group for the viewer: atmos, hv, mv, lv, disposal, doors, walls, wallmount, storage,
    machines, furniture, items (None = other). The first rule that matches wins."""
    names = set(comps)
    tags = set()
    t = comps.get("Tag", {}).get("tags")
    if isinstance(t, list):
        tags = {str(x) for x in t}
    sprite = str(e.get("s", "")).lstrip("/").replace("Textures/", "", 1)
    f = str(d.get("__file", ""))
    if any(n.startswith("Disposal") for n in names if n not in ("DisposalUnit",)) and "MailingUnit" not in names:
        return "disposal"
    if "Cable" in names or e.get("cab"):
        pre = (e.get("cab") or [""])[0].lower() or pid.lower()
        for k in ("hv", "mv", "lv"):
            if pre.startswith(k) or ("cable" + k) in pid.lower():
                return k
        return "lv"
    if names & {"AtmosPipeLayers", "AtmosPipeColor", "PipeAppearance", "GasVentPump", "GasVentScrubber",
                "GasPassiveVent", "GasPressurePump", "GasVolumePump", "GasFilter", "GasMixer", "GasValve",
                "GasOutletInjector", "GasThermoMachine", "PipeRestrictOverlap"} and "GasPortable" not in names:
        return "atmos"
    if names & {"Door", "Airlock", "Firelock"}:
        return "doors"
    sm = e.get("sm")
    if tags & {"Wall", "Window"} or (sm and sm[0] in ("walls", "windows")) or \
            sprite.startswith(("Structures/Walls/", "Structures/Windows/")) or \
            "/Structures/Walls/" in f or "/Structures/Windows/" in f:
        return "walls"
    if "WallMount" in names or e.get("d") == 2 or "/Wallmounts/" in f or sprite.startswith("Structures/Wallmounts/") \
            or names & {"Apc", "AirAlarm", "FireAlarm", "Intercom", "PoweredLight", "Sign", "ExtinguisherCabinet"}:
        return "wallmount"
    if names & {"EntityStorage"} or "/Structures/Storage/" in f or sprite.startswith("Structures/Storage/"):
        return "storage"
    if names & {"Machine", "VendingMachine", "Lathe", "Computer", "ComputerBoard", "MaterialStorage",
                "PowerNetworkBattery", "PowerSupplier", "Battery", "GravityGenerator", "ParticleAcceleratorControlBox",
                "SingularityGenerator", "ContainmentFieldGenerator", "Thruster", "ShuttleConsole", "RadarConsole",
                "MedicalScanner", "CloningPod", "Microwave", "ReagentDispenser", "ChemMaster", "Anomaly"} or \
            sprite.startswith(("Structures/Machines/", "Structures/Power/", "Structures/Shuttles/")) or \
            "/Structures/Machines/" in f or "/Structures/Power/" in f or "/Structures/Shuttles/" in f:
        return "machines"
    if "/Furniture/" in f or sprite.startswith("Structures/Furniture/") or "Strap" in names or \
            "Table" in tags or (sm and "table" in sm[0].lower()):
        return "furniture"
    if "Item" in names:
        return "items"
    return None


def build(res):
    docs = load_all(os.path.join(res, "Prototypes"))
    ents, tiles, decals = {}, {}, {}
    talias = {str(d["id"]): str(d["target"]) for d in docs
              if d.get("type") == "tileAlias" and d.get("id") and d.get("target")}
    migrate = {}
    mp = os.path.join(res, "migration.yml")
    if os.path.exists(mp):
        try:
            with open(mp, encoding="utf-8-sig") as fh:
                for k, v in (yaml.load(fh, Loader=L) or {}).items():
                    migrate[str(k)] = None if v in (None, "", "null") else str(v)
        except Exception as e:
            print("migration.yml:", e, file=sys.stderr)
    partials = [d for d in docs if isinstance(d.get("type"), Partial)]
    docs = [d for d in docs if not isinstance(d.get("type"), Partial)]
    for d in docs:
        t = d.get("type")
        if t == "entity" and d.get("id"):
            ents[str(d["id"])] = d
        elif t == "tile" and d.get("id"):
            tiles[str(d["id"])] = d
        elif t == "decal" and d.get("id"):
            decals[str(d["id"])] = d

    # ---- apply Starlight partial prototypes (merge into the base definition)
    for pd in partials:
        t, pid = str(pd["type"]), str(pd.get("id"))
        tgt = {"entity": ents, "tile": tiles, "decal": decals}.get(t)
        if tgt is None or pid not in tgt:
            continue
        base = tgt[pid]
        for k, v in pd.items():
            if k in ("type", "id", "__file"):
                continue
            if k == "components" and isinstance(v, list):
                lst = list(base.get("components") or [])
                for c in v:
                    if not isinstance(c, dict): continue
                    for i, bc in enumerate(lst):
                        if isinstance(bc, dict) and bc.get("type") == c.get("type"):
                            lst[i] = {**bc, **c}; break
                    else:
                        lst.append(c)
                base["components"] = lst
            else:
                base[k] = v

    # ---- resolve entity inheritance (component-level, field-wise merge)
    cache = {}
    def resolve(pid, stack=()):
        if pid in cache:
            return cache[pid]
        d = ents.get(pid)
        if d is None or pid in stack:
            return {"comps": {}, "name": None}
        comps, name = {}, None
        parents = d.get("parent")
        if parents:
            for p in (parents if isinstance(parents, list) else [parents]):
                r = resolve(str(p), stack + (pid,))
                for k, v in r["comps"].items():
                    comps[k] = {**comps.get(k, {}), **v}
                name = name or r["name"]
        for c in d.get("components") or []:
            if isinstance(c, dict) and c.get("type"):
                k = c["type"]
                comps[k] = {**comps.get(k, {}), **{a: b for a, b in c.items() if a != "type"}}
        if d.get("name"):
            name = d["name"]
        cache[pid] = {"comps": comps, "name": name}
        return cache[pid]

    MARKER_COMPS = {"Marker", "SpawnPoint", "ConditionalSpawner", "RandomSpawner",
                    "EntityTableSpawner", "TimedSpawner", "NavMapBeacon_"}
    out_e = {}
    for pid, d in ents.items():
        r = resolve(pid)
        comps = r["comps"]
        sp = comps.get("Sprite")
        e = {}
        if sp is not None:
            if sp.get("sprite"): e["s"] = str(sp["sprite"])
            if sp.get("state") is not None: e["st"] = str(sp["state"])
            if sp.get("texture"): e["t"] = str(sp["texture"])
            lys = [x for x in (clean_layer(l) for l in (sp.get("layers") or [])) if x is not None]
            if lys: e["l"] = lys
            dd = sp.get("drawdepth")
            if dd is not None:
                e["d"] = DRAW.get(str(dd), int(dd) if str(dd).lstrip("-").isdigit() else 0)
            o = vec(sp.get("offset"))
            if o and (o[0] or o[1]): e["o"] = o
            sc = vec(sp.get("scale"))
            if sc and sc != [1.0, 1.0]: e["sc"] = sc
            c = color(sp.get("color"))
            if c: e["c"] = c
            if str(sp.get("noRot", "")).lower() == "true": e["nr"] = 1
            if str(sp.get("snapCardinals", "")).lower() == "true": e["snap"] = 1
            if sp.get("visible") is False or str(sp.get("visible")).lower() == "false": e["v"] = 0
            if sp.get("rotation") is not None:
                rr = angle(sp.get("rotation"))
                if rr: e["r"] = rr
        elif comps.get("Icon"):
            ic = comps["Icon"]
            if ic.get("sprite"): e["s"] = str(ic["sprite"])
            if ic.get("state"): e["st"] = str(ic["state"])
            e["icon"] = 1
        ism = comps.get("IconSmooth")
        if ism and ism.get("key"):
            e["sm"] = [str(ism.get("key")), str(ism.get("base", "")), str(ism.get("mode", "Corners")),
                       [str(x) for x in (ism.get("additionalKeys") or [])]]
        cv = comps.get("CableVisualizer")
        if cv and cv.get("statePrefix"):
            e["cab"] = [str(cv["statePrefix"]), str(cv.get("extraLayerPrefix") or "")]
        door = comps.get("Door")
        if door is not None:
            st = str(door.get("state", "Closed")).lower()
            e["door"] = "open" if st in ("open", "opening") else "closed"
            od = door.get("openDrawDepth")
            if od is not None:
                e["dod"] = DRAW.get(str(od), 0)
        if "SubFloorHide" in comps:
            e["sub"] = 1
        # placed (anchored) vs loose looks
        xf = comps.get("Transform", {})
        if str(xf.get("anchored", "")).lower() == "true":
            e["anc"] = 1
        gv = comps.get("GenericVisualizer", {}).get("visuals")
        if isinstance(gv, dict):
            av = gv.get("enum.AnchorVisuals.Anchored")
            if isinstance(av, dict):
                out = {}
                for mapkey, states in av.items():
                    if not isinstance(states, dict):
                        continue
                    for k, ld in states.items():
                        kk = "1" if str(k).lower() == "true" else "0"
                        if isinstance(ld, dict):
                            d2 = {}
                            if ld.get("state") is not None: d2["st"] = str(ld["state"])
                            if ld.get("visible") is not None: d2["v"] = 0 if str(ld["visible"]).lower() == "false" else 1
                            out.setdefault(kk, {})[str(mapkey)] = d2
                if out:
                    e["anv"] = out
        # atmos pipes: node directions, pipe layer and the connector sprites drawn when placed
        nodes = comps.get("NodeContainer", {}).get("nodes")
        mask = 0
        if isinstance(nodes, dict):
            for nd in nodes.values():
                if isinstance(nd, dict) and nd.get("pipeDirection"):
                    mask |= pipe_mask(str(nd["pipeDirection"]))
        if mask:
            e["pd"] = mask
        if "PipeAppearance" in comps:
            spr = comps["PipeAppearance"].get("sprite")
            conns = []
            if isinstance(spr, list):
                for x in spr:
                    if isinstance(x, dict) and x.get("sprite"):
                        conns.append([str(x["sprite"]), str(x.get("state", "pipeConnector"))])
            e["pa"] = conns or DEFAULT_CONNECTORS
        apl = comps.get("AtmosPipeLayers")
        if apl is not None:
            li = pipe_layer(apl.get("pipeLayer"))
            if li:
                e["pl"] = li
            slr = apl.get("spriteLayersRsiPaths")
            if isinstance(slr, dict):
                plr = {}
                for mk, by in slr.items():
                    if isinstance(by, dict):
                        arr = [None] * 5
                        for ln, rp in by.items():
                            i = pipe_layer(ln)
                            if i is not None and i < 5: arr[i] = str(rp)
                        plr[str(mk)] = arr
                if plr: e["plr"] = plr
            srp = apl.get("spriteRsiPaths")
            if isinstance(srp, dict):
                arr = [None] * 5
                for ln, rp in srp.items():
                    i = pipe_layer(ln)
                    if i is not None and i < 5: arr[i] = str(rp)
                e["prs"] = arr
        apc = comps.get("AtmosPipeColor")
        if apc and apc.get("color"):
            e["pc"] = str(apc["color"])
        if MARKER_COMPS & set(comps) or str(e.get("s", "")).startswith("Markers/"):
            e["mk"] = 1
        cat = categorize(pid, d, comps, e)
        if cat:
            e["cat"] = cat
        if not e:
            continue
        if r["name"]: e["n"] = str(r["name"])
        if d.get("abstract"):
            continue
        out_e[pid] = e

    # ---- tiles
    tcache = {}
    def tres(tid, stack=()):
        if tid in tcache: return tcache[tid]
        d = tiles.get(tid)
        if d is None or tid in stack: return {}
        m = {}
        p = d.get("parent")
        if p:
            for pp in (p if isinstance(p, list) else [p]):
                m.update(tres(str(pp), stack + (tid,)))
        m.update(d)
        tcache[tid] = m
        return m
    out_t = {}
    for tid in tiles:
        m = tres(tid)
        o = {}
        if m.get("sprite"): o["s"] = str(m["sprite"])
        v = m.get("variants")
        if v and int(v) > 1: o["v"] = int(v)
        if m.get("name"): o["n"] = str(m["name"])
        if str(m.get("isSubfloor", "")).lower() == "true": o["sub"] = 1
        out_t[tid] = o

    out_d = {}
    for did, d in decals.items():
        s = d.get("sprite")
        o = {}
        if isinstance(s, dict):
            if s.get("sprite"): o["s"] = str(s["sprite"])
            if s.get("state") is not None: o["st"] = str(s["state"])
            if s.get("texture"): o["t"] = str(s["texture"])
        elif isinstance(s, str):
            o["t"] = s
        if o: out_d[did] = o

    return out_e, out_t, out_d, talias, migrate

def main():
    import argparse, datetime
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("resources", help="Resources/ folder of the main fork")
    ap.add_argument("out")
    ap.add_argument("--repo", default=""); ap.add_argument("--commit", default="")
    ap.add_argument("--extra", nargs=3, action="append", default=[], metavar=("RESOURCES", "REPO", "COMMIT"),
                    help="another fork; only prototypes the main fork lacks are taken from it")
    ap.add_argument("--maps-out", default="", help="also write a list of map .yml paths here")
    ap.add_argument("--maps-file", default="", help="text file with map paths (one per line) instead of walking Resources/Maps")
    a = ap.parse_args()
    out_e, out_t, out_d, out_ta, out_mg = build(a.resources)
    sources = [{"repo": a.repo, "commit": a.commit}]
    for k, (res, repo, commit) in enumerate(a.extra, start=1):
        e2, t2, d2, ta2, mg2 = build(res)
        n = 0
        for k2, v2 in ta2.items(): out_ta.setdefault(k2, v2)
        for k2, v2 in mg2.items(): out_mg.setdefault(k2, v2)
        for src, dst in ((e2, out_e), (t2, out_t), (d2, out_d)):
            for key, v in src.items():
                if key not in dst:
                    v["src"] = k
                    dst[key] = v
                    n += 1
        sources.append({"repo": repo, "commit": commit, "added": n})
        print(f"{repo}: added {n} prototypes the main fork does not have")
    # pipe-layer RSI lists repeat a lot: store each once in "sets" and refer to it by index
    sets, set_idx = [], {}
    def ref(arr):
        k = json.dumps(arr)
        if k not in set_idx:
            set_idx[k] = len(sets)
            sets.append(arr)
        return set_idx[k]
    for e in out_e.values():
        if "plr" in e:
            e["plr"] = {mk: ref(arr) for mk, arr in e["plr"].items()}
        if "prs" in e:
            e["prs"] = ref(e["prs"])
        if "pa" in e:
            e["pa"] = ref(e["pa"])
    db = {"v": 1, "repo": a.repo, "commit": a.commit, "sources": sources, "sets": sets,
          "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
          "ent": out_e, "tile": out_t, "decal": out_d, "tileAlias": out_ta, "migrate": out_mg}
    with open(a.out, "w") as fh:
        json.dump(db, fh, separators=(",", ":"))
    if a.maps_out:
        if a.maps_file:
            with open(a.maps_file) as fh:
                maps = sorted(l.strip().replace("Resources/", "", 1) for l in fh if l.strip().endswith(".yml"))
        else:
            mroot = os.path.join(a.resources, "Maps")
            maps = sorted(os.path.relpath(os.path.join(dp, f), a.resources).replace(os.sep, "/")
                          for dp, _, fs in os.walk(mroot) for f in fs if f.endswith(".yml"))
        with open(a.maps_out, "w") as fh:
            json.dump({"repo": a.repo, "commit": a.commit, "maps": maps}, fh, indent=0)
    print(f"entities {len(out_e)}  tiles {len(out_t)}  decals {len(out_d)}  -> {os.path.getsize(a.out)/1e6:.2f} MB")

if __name__ == "__main__":
    main()
