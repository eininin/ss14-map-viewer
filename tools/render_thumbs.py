#!/usr/bin/env python3
"""Pre-render map previews for Browse maps (stations and shuttles).

usage: render_thumbs.py --src <dir with <server>/Resources/Maps> [--forks a,b] [--limit N]

For every station / shuttle in db/maps-<server>.json this writes
  thumbs/<server>/<path>.webp      small preview (~200 px), transparent
  thumbs/<server>/<path>.lg.webp   hover preview (~800 px), transparent
  thumbs/<server>/index.json       { map path: {h: file hash, w, h, sw, sh} }
Maps whose file did not change since the last run are skipped. It serves this repo on a
local port and drives thumbs.html in headless Chromium, so the previews are drawn by the
viewer's own renderer.
"""
import argparse, base64, functools, hashlib, http.server, json, os, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CATS = {"station", "shuttle"}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def slug(p):
    return p[len("Maps/"):-4] if p.startswith("Maps/") and p.endswith(".yml") else p


# drawing code: when it changes, every preview is drawn again
RENDER_V = b"".join(open(os.path.join(ROOT, "js", f), "rb").read()
                    for f in ("scene.js", "thumbs.js", "packs.js", "mapparse.js"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--forks", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--big", type=int, default=800)
    ap.add_argument("--small", type=int, default=200)
    a = ap.parse_args()
    port = serve()
    sources = json.load(open(os.path.join(ROOT, "sources.json")))["sources"]
    forks = [s["id"] for s in sources if not a.forks or s["id"] in a.forks.split(",")]
    proxy = os.environ.get("HTTPS_PROXY")
    with sync_playwright() as p:
        browser = p.chromium.launch(proxy={"server": proxy, "bypass": "127.0.0.1,localhost"} if proxy else None)
        for fid in forks:
            maps_file = os.path.join(ROOT, "db", f"maps-{fid}.json")
            if not os.path.exists(maps_file):
                continue
            rows = [r for r in json.load(open(maps_file))["maps"] if r["c"] in CATS]
            outdir = os.path.join(ROOT, "thumbs", fid)
            os.makedirs(outdir, exist_ok=True)
            idx_path = os.path.join(outdir, "index.json")
            idx = json.load(open(idx_path)) if os.path.exists(idx_path) else {}
            todo = []
            for r in rows:
                full = os.path.join(a.src, fid, "Resources", r["p"])
                if not os.path.exists(full):
                    continue
                h = hashlib.sha1(open(full, "rb").read() + RENDER_V).hexdigest()[:16]
                base = os.path.join(outdir, slug(r["p"]))
                if idx.get(r["p"], {}).get("h") == h and os.path.exists(base + ".webp") and os.path.exists(base + ".lg.webp"):
                    continue
                todo.append((r, full, h, base))
            if a.limit:
                todo = todo[:a.limit]
            # forget previews of maps that are gone
            keep = {r["p"] for r in rows}
            for pth in [k for k in idx if k not in keep]:
                for ext in (".webp", ".lg.webp"):
                    try: os.remove(os.path.join(outdir, slug(pth)) + ext)
                    except OSError: pass
                del idx[pth]
            print(f"{fid}: {len(rows)} stations/shuttles, {len(todo)} to render", flush=True)
            if not todo:
                json.dump(idx, open(idx_path, "w"), separators=(",", ":"), sort_keys=True)
                continue
            page = browser.new_page()
            page.set_default_timeout(300000)
            page.goto(f"http://127.0.0.1:{port}/thumbs.html")
            page.wait_for_function("window.__thumbs !== undefined")
            page.evaluate("async () => window.__thumbs.init()")
            page.evaluate("async (id) => window.__thumbs.useFork(id)", fid)
            t0 = time.time()
            for i, (r, full, h, base) in enumerate(todo):
                text = open(full, encoding="utf-8-sig", errors="replace").read()
                try:
                    res = page.evaluate("async ([t, b, s]) => window.__thumbs.render(t, { big: b, small: s })", [text, a.big, a.small])
                except Exception as e:
                    print(f"  ! {r['p']}: {str(e).splitlines()[0][:160]}", flush=True)
                    continue
                os.makedirs(os.path.dirname(base), exist_ok=True)
                open(base + ".lg.webp", "wb").write(base64.b64decode(res["big"].split(",", 1)[1]))
                open(base + ".webp", "wb").write(base64.b64decode(res["small"].split(",", 1)[1]))
                idx[r["p"]] = {"h": h, "w": res["w"], "h_": res["h"], "sw": res["sw"], "sh": res["sh"]}
                if (i + 1) % 10 == 0 or i + 1 == len(todo):
                    print(f"  {fid} {i + 1}/{len(todo)}  {time.time() - t0:.0f}s", flush=True)
                    json.dump(idx, open(idx_path, "w"), separators=(",", ":"), sort_keys=True)
                # a fresh page now and then keeps memory in check on big stations
                if (i + 1) % 80 == 0:
                    page.close()
                    page = browser.new_page()
                    page.set_default_timeout(300000)
                    page.goto(f"http://127.0.0.1:{port}/thumbs.html")
                    page.wait_for_function("window.__thumbs !== undefined")
                    page.evaluate("async () => window.__thumbs.init()")
                    page.evaluate("async (id) => window.__thumbs.useFork(id)", fid)
            page.close()
            json.dump(idx, open(idx_path, "w"), separators=(",", ":"), sort_keys=True)
        browser.close()


if __name__ == "__main__":
    main()
