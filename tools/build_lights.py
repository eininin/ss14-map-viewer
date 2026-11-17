#!/usr/bin/env python3
"""Light data for the optional "realistic lighting" view (js/lighting.js).

Writes db/lights-<server>.json, separate from the sprite database:
  ent: { proto: { "pl": [radius, energy, softness, falloff, curve, "#rrggbb", offX, offY, shadows],
                  "un": { "s": [unshaded states], "m": [unshaded layer map keys] } } }

Lights are taken as on a normal running station: light fixtures use the bulb they spawn with,
lights that come on with power are on, lights that are off by default (emergency lights) stay off.
The whole feature can be removed by deleting this file, js/lighting.js, db/lights-*.json and the
two marked lines in js/app.js and the workflow.

usage: build_lights.py <Resources folder> <out.json>
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_db as B  # noqa: E402  (only its loaders are used; build_db itself is not changed)


def resolved(res):
    docs = B.load_all(os.path.join(res, "Prototypes"))
    partials = [d for d in docs if isinstance(d.get("type"), B.Partial)]
    ents = {str(d["id"]): d for d in docs
            if not isinstance(d.get("type"), B.Partial) and d.get("type") == "entity" and d.get("id")}
    for pd in partials:                       # Starlight partial prototypes
        if str(pd["type"]) != "entity" or str(pd.get("id")) not in ents:
            continue
        base = ents[str(pd["id"])]
        lst = list(base.get("components") or [])
        for c in pd.get("components") or []:
            if not isinstance(c, dict):
                continue
            for i, bc in enumerate(lst):
                if isinstance(bc, dict) and bc.get("type") == c.get("type"):
                    lst[i] = B.deep_merge(bc, c)
                    break
            else:
                lst.append(c)
        base["components"] = lst
    cache = {}

    def resolve(pid, stack=()):
        if pid in cache:
            return cache[pid]
        d = ents.get(pid)
        if d is None or pid in stack:
            return {}
        comps = {}
        parents = d.get("parent")
        for p in (parents if isinstance(parents, list) else [parents] if parents else []):
            for k, v in resolve(str(p), stack + (pid,)).items():
                comps[k] = {**comps.get(k, {}), **v}
        for c in d.get("components") or []:
            if isinstance(c, dict) and c.get("type"):
                comps[c["type"]] = {**comps.get(c["type"], {}), **{a: b for a, b in c.items() if a != "type"}}
        cache[pid] = comps
        return comps

    return {pid: resolve(pid) for pid in ents}


def num(v, d):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def hexcol(v, d="#ffffff"):
    if not v:
        return d
    s = str(v).strip()
    if s.startswith("#") and len(s) >= 7:
        return s[:7].lower()
    return d


def main():
    res, out = sys.argv[1], sys.argv[2]
    allc = resolved(res)
    result = {}
    for pid, comps in allc.items():
        e = {}
        pl = comps.get("PointLight")
        if isinstance(pl, dict):
            on = pl.get("enabled", True) not in (False, "false", "False")
            powered = "PoweredLight" in comps or "LitOnPowered" in comps
            if on or powered:
                r, en = num(pl.get("radius"), 5.0), num(pl.get("energy"), 1.0)
                sf, col = num(pl.get("softness"), 1.0), hexcol(pl.get("color"))
                pw = comps.get("PoweredLight")
                if isinstance(pw, dict) and pw.get("hasLampOnSpawn"):
                    bulb = allc.get(str(pw["hasLampOnSpawn"]), {}).get("LightBulb")
                    if isinstance(bulb, dict):     # the fixture shines with its bulb's light
                        r = num(bulb.get("lightRadius"), r)
                        en = num(bulb.get("lightEnergy"), en)
                        sf = num(bulb.get("lightSoftness"), sf)
                        col = hexcol(bulb.get("color"), col)
                    elif isinstance(pw, dict) and pw.get("hasLampOnSpawn") is not None and not bulb:
                        pass
                off = B.vec(pl.get("offset")) or [0, 0]
                if r > 0 and en > 0:
                    e["pl"] = [round(r, 3), round(en, 3), round(sf, 3), round(num(pl.get("falloff"), 6.8), 3),
                               round(num(pl.get("curveFactor"), 0.0), 3), col, off[0], off[1],
                               0 if pl.get("castShadows") in (False, "false") else 1]
        sp = comps.get("Sprite")
        if isinstance(sp, dict):
            st, mk = set(), set()
            for l in sp.get("layers") or []:
                if isinstance(l, dict) and str(l.get("shader", "")).lower() == "unshaded":
                    if l.get("state") is not None:
                        st.add(str(l["state"]))
                    m = l.get("map")
                    for k in (m if isinstance(m, list) else [m] if m else []):
                        mk.add(str(k))
            if str(sp.get("shader", "")).lower() == "unshaded":
                e["ua"] = 1                    # the whole sprite glows
            if st or mk:
                e["un"] = {"s": sorted(st), "m": sorted(mk)}
        if e:
            result[pid] = e
    with open(out, "w") as fh:
        json.dump({"v": 1, "ent": result}, fh, separators=(",", ":"))
    n = sum(1 for v in result.values() if "pl" in v)
    print(f"lights: {n} light sources, {len(result) - n} other glowing sprites -> {os.path.getsize(out) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
