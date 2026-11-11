// Render whole maps to transparent images (used by tools/render_thumbs.py through thumbs.html).
// Draws the "as in game" look: pipes under floors hidden, no markers, first animation frame.
/* global jsyaml, parseMap */
import { Pack, SpriteStore, texRel } from './packs.js';
import { buildScene, SceneRenderer, PX, CHUNK, DEFAULT_OPTS } from './scene.js';

const T = { forks: [], commits: {}, extra: [], fork: null, db: null, store: null };

async function json(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }

export async function init() {
  T.forks = (await json('sources.json')).sources;
  try { T.commits = (await json('db/commits.json')).commits || {}; } catch (e) { T.commits = {}; }
  try { T.extra = (await json('packs.json')).extra || []; } catch (e) { T.extra = []; }
  return T.forks.map(f => f.id);
}

const forkById = (id) => T.forks.find(f => f.id === id);
const ghPack = (f, extra) => ({ id: f.id, name: f.name, type: 'github', repo: f.repo, ref: '{commit:' + f.id + '}', path: 'Resources/Textures', ...extra });
function stack(f) {
  const own = f.pack
    ? [{ id: f.id, name: f.name, type: 'site', path: f.pack.path }, ...(f.pack.base || []).map(b => ghPack(forkById(b), { id: f.id + '-base-' + b }))]
    : [ghPack(f)];
  return [...T.extra, ...own];
}

// the same server's sprites are reused for every map rendered after this
export async function useFork(id) {
  const f = forkById(id);
  T.fork = f;
  T.db = await json(`db/sprites-${id}.json`);
  T.store = new SpriteStore();
  const ctx = { siteRepo: '', siteBranch: 'main', dbCommit: T.db.commit, commits: T.commits };
  T.store.setPacks(stack(f).map(c => new Pack({ enabled: true, ...c }, ctx)));
  return { entities: Object.keys(T.db.ent).length };
}

function gridWorld(xf, lx, ly) {
  const c = Math.cos(xf.r), s = Math.sin(xf.r);
  return [xf.x + lx * c - ly * s, xf.y + lx * s + ly * c];
}

// returns { big, small } as data URLs (WebP with transparency) plus the size in tiles
export async function render(text, opts = {}) {
  const big = opts.big || 800, small = opts.small || 200, maxPx = opts.maxPx || 32;
  const model = parseMap(text, jsyaml);
  const scene = buildScene(model, T.db, {});
  const store = T.store;
  const resolved = new Map();
  const key = (n) => n.tex ? 't|' + texRel(n.tex) : 's|' + texRel(n.rsi) + '|' + n.state;
  await Promise.all(scene.needs.map(async (n) => {
    resolved.set(key(n), n.tex ? await store.texture(n.tex) : await store.state(n.rsi, n.state));
  }));
  let missing = 0;
  for (const [, list] of scene.tiles) for (const t of list) {
    t.res = t.td && t.td.s ? resolved.get('t|' + texRel(t.td.s)) : store.dev();
  }
  const fix = (l) => {
    if (l.dev) { l.res = store.dev(); return; }
    if (l.tex) l.res = resolved.get('t|' + texRel(l.tex));
    else if (l.rsi && l.state != null) l.res = resolved.get('s|' + texRel(l.rsi) + '|' + l.state);
    else l.res = null;
    if (l.res && l.res.dev && !l.hidden && !l.runtimeHidden) missing++;
  };
  const r = new SceneRenderer(store);
  r.opts = { ...DEFAULT_OPTS };
  for (const it of scene.items) {
    for (const l of it.layers) fix(l);
    if (it.alt) for (const l of it.alt.layers) fix(l);
    r.computeRadius(it);
  }
  r.setScene(model, scene);
  for (const gr of r.grids.values()) gr.ov = null;      // no zoomed-out overview needed here

  // world bounds of everything drawn (floors and objects)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const gr of r.grids.values()) {
    if (!isFinite(gr.minX)) continue;
    for (const [lx, ly] of [[gr.minX, gr.minY], [gr.maxX, gr.minY], [gr.minX, gr.maxY], [gr.maxX, gr.maxY]]) {
      const [wx, wy] = gridWorld(gr.xf, lx, ly);
      x0 = Math.min(x0, wx); y0 = Math.min(y0, wy); x1 = Math.max(x1, wx); y1 = Math.max(y1, wy);
    }
  }
  if (!isFinite(x0)) throw new Error('nothing to draw');
  const wT = x1 - x0, hT = y1 - y0;
  const P = Math.min(maxPx, big / Math.max(wT, hT));          // pixels per tile in the large image
  const W = Math.max(1, Math.round(wT * P)), H = Math.max(1, Math.round(hT * P));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = P < PX;
  g.imageSmoothingQuality = 'high';
  for (const gr of r.grids.values()) {
    const c = Math.cos(gr.xf.r), s = Math.sin(gr.xf.r);
    // grid-local tiles -> image pixels (y up in the world, down in the image)
    g.setTransform(P * c, -P * s, -P * s, -P * c, P * (gr.xf.x - x0), P * (y1 - gr.xf.y));
    for (const ch of gr.chunks.values()) {
      r.renderChunk(gr, ch);
      g.save();
      g.translate(ch.cx * CHUNK, (ch.cy + 1) * CHUNK);
      g.scale(1 / PX, -1 / PX);
      g.drawImage(ch.canvas, 0, 0);
      g.restore();
      ch.canvas = null;                                       // keep memory low on big stations
    }
  }
  // small image: halve in steps for a clean downscale
  let src = cv;
  const target = small / Math.max(W, H);
  let w = W, h = H;
  while (w * target < w / 2 && w > 2) {
    const half = document.createElement('canvas');
    half.width = Math.max(1, Math.round(w / 2)); half.height = Math.max(1, Math.round(h / 2));
    const hg = half.getContext('2d');
    hg.imageSmoothingEnabled = true; hg.imageSmoothingQuality = 'high';
    hg.drawImage(src, 0, 0, half.width, half.height);
    src = half; w = half.width; h = half.height;
  }
  const sm = document.createElement('canvas');
  sm.width = Math.max(1, Math.round(W * target)); sm.height = Math.max(1, Math.round(H * target));
  if (target >= 1) { sm.width = W; sm.height = H; }
  const sg = sm.getContext('2d');
  sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
  sg.drawImage(src, 0, 0, sm.width, sm.height);
  return {
    big: cv.toDataURL('image/webp', 0.86), small: sm.toDataURL('image/webp', 0.86),
    w: W, h: H, sw: sm.width, sh: sm.height, tilesW: Math.round(wT), tilesH: Math.round(hT), missing,
  };
}

window.__thumbs = { init, useFork, render, _miss: () => [...T.store.missing.keys()].filter(k => !/\|\d+$/.test(k)).slice(0, 40), _packs: () => T.store.packs.map(p => [p.id, p.type, p.hits]) };
