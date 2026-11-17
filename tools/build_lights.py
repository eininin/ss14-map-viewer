#!/usr/bin/env python3
"""Light data for the optional "realistic lighting" view (js/lighting.js).

Writes db/lights-<server>.json, separate from the sprite database:
  ent: { proto: { "pl": { r: radius, e: energy, s: softness, f: falloff, c: curveFactor, col: "#rrggbb",
                          o: [offX, offY], sh: castShadows, m: mask texture path, ar: mask turns with the entity },
                  "un": { "s": [unshaded states], "m": [unshaded layer map keys] } } }

Lights are taken as on a normal running station in daytime (SharedPoweredLightSystem.UpdateLight): a light
fixture shines with the bulb it spawns with (LightBulbComponent: energy 0.8, radius 10, softness 1, white
unless the bulb says otherwise), light floors scale that (LightFloorComponent: energy x0.6, radius at most 4),
a fixture without a bulb is dark; lights that come on with power are on, lights that are off by default
(emergency lights) stay off. Light masks come from lightMask prototypes (PointLight.lightMask).
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
    masks = {}
    for d in B.load_all(os.path.join(res, "Prototypes")):
        if d.get("type") == "lightMask" and d.get("id") and d.get("maskPath"):
            masks[str(d["id"])] = str(d["maskPath"])
    for pid, comps in allc.items():
        e = {}
        pl = comps.get("PointLight")
        if isinstance(pl, dict):
            on = pl.get("enabled", True) not in (False, "false", "False")
            r, en = num(pl.get("radius"), 5.0), num(pl.get("energy"), 1.0)
            sf, col = num(pl.get("softness"), 1.0), hexcol(pl.get("color"))
            pw = comps.get("PoweredLight")
            if isinstance(pw, dict):
                bulb_id = pw.get("hasLampOnSpawn")
                bulb = allc.get(str(bulb_id), {}).get("LightBulb") if bulb_id else None
                on = isinstance(bulb, dict) and pw.get("on", True) not in (False, "false", "False") \
                    and str(bulb.get("startingState", "Normal")) == "Normal"
                if on:                              # SetLight(color, radius, energy, softness) from the bulb
                    en = num(bulb.get("lightEnergy"), 0.8)
                    r = num(bulb.get("lightRadius"), 10.0)
                    sf = num(bulb.get("lightSoftness"), 1.0)
                    col = hexcol(bulb.get("color"), "#ffffff")
                    lf = comps.get("LightFloor")
                    if isinstance(lf, dict):
                        en *= num(lf.get("energyMultiplier"), 0.6)
                        r = min(r, num(lf.get("maxRadius"), 4.0))
            elif "LitOnPowered" in comps:
                on = True
            off = B.vec(pl.get("offset")) or [0, 0]
            if on and r > 0 and en > 0:
                rec = {"r": round(r, 4), "e": round(en, 4), "s": round(sf, 4), "f": round(num(pl.get("falloff"), 6.8), 4),
                       "c": round(num(pl.get("curveFactor"), 0.0), 4), "col": col, "o": [off[0], off[1]],
                       "sh": 0 if pl.get("castShadows") in (False, "false", "False") else 1}
                lm = pl.get("lightMask")
                if lm and str(lm) in masks:
                    rec["m"] = masks[str(lm)]
                    if pl.get("autoRot") in (True, "true", "True"):
                        rec["ar"] = 1
                e["pl"] = rec
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
        json.dump({"v": 2, "ent": result}, fh, separators=(",", ":"))
    n = sum(1 for v in result.values() if "pl" in v)
    print(f"lights: {n} light sources, {len(result) - n} other glowing sprites -> {os.path.getsize(out) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
