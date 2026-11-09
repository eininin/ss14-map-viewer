import { Pack, SpriteStore, localPackFromFiles, texRel, DEV } from './packs.js';
import { buildScene, SceneRenderer, PX, CHUNK, LAYER_KEYS, DEFAULT_OPTS } from './scene.js';
import { Annotations } from './annot.js';
import { GitHub } from './github.js';
import { openImageViewer } from './imageviewer.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ss14mv.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ss14mv.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  del(k) { try { localStorage.removeItem('ss14mv.' + k); } catch (e) { /* ignore */ } },
};

// ---------------------------------------------------------------- state
const S = {
  config: { repo: '', branch: 'main', db: 'db/sprites.json' },
  db: null,
  packCfgs: [],          // ordered configs (local packs keep their file maps here)
  defaultPacks: [],
  store: new SpriteStore(),
  renderer: null,
  model: null,
  scene: null,
  mapSource: null,       // {kind:'file'|'url'|'starlight'|'repo', name, text, ref}
  cam: { x: 0, y: 0, s: 32 },
  tool: 'pan',
  color: LS.get('color', '#ffd23f'),
  size: LS.get('size', 3),
  selection: null,       // {hits, idx, tile, world}
  highlight: null,       // {label, items:[it]}
  showGrid: false,
  bg: LS.get('bg', '#06080d'),
  loadToken: 0,
};
S.renderer = new SceneRenderer(S.store);
const annots = new Annotations(() => { saveAnnotsLocal(); drawOverlay(); updateDrawStats(); });
let gh = null;

const mapCanvas = $('#mapCanvas'), overlay = $('#overlayCanvas');
const mctx = mapCanvas.getContext('2d'), octx = overlay.getContext('2d');
let W = 0, H = 0, DPR = 1;

// ---------------------------------------------------------------- utils
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2200);
}
function progress(frac, text) {
  const p = $('#progress');
  if (frac == null) { p.hidden = true; return; }
  p.hidden = false;
  $('#progBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  $('#progText').textContent = text || '';
}
function status(msg) { $('#stMsg').textContent = msg || ''; }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Copy failed: ' + e.message, true); }
}
async function copyImage(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied');
  } catch (e) { toast('Copy failed: ' + e.message, true); }
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const baseName = (p) => String(p).split('/').pop();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const idle = () => new Promise(r => (window.requestIdleCallback || setTimeout)(r));

// guess this site's repo from a github.io URL when config.json doesn't say
function guessRepo() {
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  if (!m) return '';
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return seg ? `${m[1]}/${seg}` : `${m[1]}/${m[1]}.github.io`;
}

// ---------------------------------------------------------------- startup
async function boot() {
  try { Object.assign(S.config, await (await fetch('config.json', { cache: 'no-cache' })).json()); } catch (e) { /* defaults */ }
  if (!S.config.repo) S.config.repo = guessRepo();
  gh = new GitHub(S.config.repo, S.config.branch);
  try { S.defaultPacks = (await (await fetch('packs.json', { cache: 'no-cache' })).json()).packs || []; } catch (e) { S.defaultPacks = []; }
  S.defaultPacks.forEach((p, i) => { p.id = p.id || ('p' + i); });
  const saved = LS.get('packs', null);
  S.packCfgs = (saved && saved.length ? saved : S.defaultPacks).map(p => ({ enabled: true, ...p }));

  progress(0.05, 'Loading sprite database…');
  try {
    S.db = await (await fetch(S.config.db)).json();
  } catch (e) {
    toast('Could not load the sprite database (' + S.config.db + ')', true);
    S.db = { ent: {}, tile: {}, decal: {} };
  }
  progress(null);
  applyPacks(false);
  setupUI();
  resize();
  renderRepoInfo();
  const q = new URLSearchParams(location.search);
  if (q.get('map')) { await loadMapLists(); openFromParam(q.get('map'), q); }
}

function packCtx() { return { siteRepo: S.config.repo, siteBranch: S.config.branch, dbCommit: S.db && S.db.commit }; }
function applyPacks(reload = true) {
  const packs = S.packCfgs.map(c => new Pack(c, packCtx()));
  S.store.setPacks(packs);
  S.packObjs = packs;
  LS.set('packs', S.packCfgs.filter(c => c.type !== 'local').map(({ files, ...c }) => c));
  renderPacks();
  if (reload && S.model) resolveAndRender(true);
}

// ---------------------------------------------------------------- map loading
let worker = null, workerId = 0;
function parseInWorker(text) {
  if (!worker) worker = new Worker('js/parse.worker.js');
  const id = ++workerId;
  return new Promise((res, rej) => {
    const on = (ev) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener('message', on);
      ev.data.ok ? res(ev.data.model) : rej(new Error(ev.data.error));
    };
    worker.addEventListener('message', on);
    worker.postMessage({ id, text });
  });
}

async function openText(text, source) {
  const token = ++S.loadToken;
  progress(0.1, 'Reading map…');
  let model;
  try {
    model = await parseInWorker(text);
  } catch (e) {
    progress(null);
    toast('Could not read this map: ' + e.message, true);
    return;
  }
  if (token !== S.loadToken) return;
  S.model = model;
  S.mapSource = { ...source, text };
  S.selection = null;
  S.highlight = null;
  S.area = null;
  $('#empty').hidden = true;
  $('#mapName').textContent = (model.name || source.name || 'map') + '  ·  ' + (source.label || source.name || '');
  document.title = (model.name || source.name) + ' – SS14 Map Viewer';
  loadAnnotsLocal();
  await resolveAndRender(false, token);
  renderInspect();
}

function mapKey() {
  if (!S.mapSource) return 'none';
  return (S.mapSource.key || S.mapSource.name || 'map');
}

async function resolveAndRender(keepView, token = S.loadToken) {
  const model = S.model;
  progress(0.2, 'Placing objects…');
  await sleep(0);
  const scene = buildScene(model, S.db, {});
  S.scene = scene;
  // load every sprite the map needs, through the pack stack
  const total = scene.needs.length;
  let done = 0;
  const resolved = new Map();
  const key = (n) => n.tex ? 't|' + texRel(n.tex) : 's|' + texRel(n.rsi) + '|' + n.state;
  const tick = () => { if ((++done & 15) === 0 || done === total) progress(0.25 + 0.6 * done / Math.max(1, total), `Sprites ${done} / ${total}`); };
  await Promise.all(scene.needs.map(async (n) => {
    const r = n.tex ? await S.store.texture(n.tex) : await S.store.state(n.rsi, n.state);
    resolved.set(key(n), r);
    tick();
  }));
  if (token !== S.loadToken) return;
  const missing = new Map();
  const noteMissing = (k, info, it) => {
    if (!missing.has(k)) missing.set(k, { ...info, count: 0, items: [], protos: new Set() });
    const m = missing.get(k);
    m.count++;
    if (it) { m.items.push(it); m.protos.add(it.proto); }
  };
  for (const [, list] of scene.tiles) for (const t of list) {
    if (t.td && t.td.s) {
      t.res = resolved.get('t|' + texRel(t.td.s));
      if (t.res && t.res.dev) noteMissing('t|' + texRel(t.td.s), { tex: texRel(t.td.s), tile: t.name });
    } else {
      t.res = S.store.dev();
      noteMissing('tile|' + t.name, { tileUnknown: t.name });
    }
  }
  for (const it of scene.items) {
    for (const l of it.layers) {
      if (l.dev) { l.res = S.store.dev(); continue; }
      if (l.tex) l.res = resolved.get('t|' + texRel(l.tex));
      else if (l.rsi && l.state != null) l.res = resolved.get('s|' + texRel(l.rsi) + '|' + l.state);
      else l.res = null;
      if (l.res && l.res.dev && !l.hidden && !l.runtimeHidden) {
        noteMissing(l.tex ? 't|' + texRel(l.tex) : 's|' + texRel(l.rsi) + '|' + l.state,
          l.tex ? { tex: texRel(l.tex) } : { rsi: texRel(l.rsi), state: l.state }, it);
      }
    }
    if (it.alt) for (const l of it.alt.layers) {
      if (l.tex) l.res = resolved.get('t|' + texRel(l.tex));
      else if (l.rsi && l.state != null) l.res = resolved.get('s|' + texRel(l.rsi) + '|' + l.state);
      else l.res = null;
    }
    if (it.unknown && it.kind === 'ent') noteMissing('proto|' + it.proto, { protoUnknown: it.proto }, it);
    S.renderer.computeRadius(it);
  }
  S.missing = missing;
  S.renderer.setScene(model, scene);
  progress(0.9, 'Drawing…');
  if (!keepView) fitView();
  renderPacks();
  renderMapPane();
  renderToggles();
  renderArea();
  draw();
  progress(null);
  backgroundFill(token);
}

// render every chunk in the background so the zoomed-out view fills in
async function backgroundFill(token) {
  const r = S.renderer;
  const all = [];
  for (const gr of r.grids.values()) for (const c of gr.chunks.values()) all.push([gr, c]);
  let n = 0;
  for (const [gr, c] of all) {
    if (token !== S.loadToken || r.scene !== S.scene) return;
    if (!gr.ov || !gr.ov.done.has(c)) {
      const t0 = performance.now();
      r.renderChunk(gr, c);
      n++;
      if (performance.now() - t0 > 4 || (n % 4) === 0) { r.evict(); draw(); await idle(); }
    }
    status(`Rendering ${n} / ${all.length}`);
  }
  r.evict();
  status('');
  draw();
}

async function openFile(file) {
  const text = await file.text();
  openText(text, { kind: 'file', name: file.name, label: 'local file', key: 'file:' + file.name });
  history.replaceState(null, '', location.pathname);
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.text();
}

async function openFromParam(v, q) {
  try {
    let url, name = baseName(v), src;
    const src0 = v.split(':')[0];
    const list = S.mapLists && S.mapLists.find(l => l.id === src0);
    if (list) {
      const p = v.slice(src0.length + 1);
      url = `https://raw.githubusercontent.com/${list.repo}/${list.commit || 'master'}/Resources/${p}`;
      src = { kind: 'fork', name, label: list.repo + ' · ' + p, key: v, param: v };
    } else if (v.startsWith('repo:')) {
      const p = v.slice(5);
      url = p;
      src = { kind: 'repo', name, label: 'this repo · ' + p, key: v, param: v, path: p };
    } else {
      url = v;
      src = { kind: 'url', name, label: v, key: v, param: v };
    }
    progress(0.05, 'Downloading ' + name + '…');
    const text = await fetchText(url);
    await openText(text, src);
    if (q && q.get('x') != null) {
      S.cam.x = +q.get('x'); S.cam.y = +q.get('y'); S.cam.s = +(q.get('z') || 1) * PX;
      draw();
    }
  } catch (e) {
    progress(null);
    toast('Could not open map: ' + e.message, true);
  }
}
let urlTimer = 0;
function syncUrl() {
  if (!S.mapSource || !S.mapSource.param) return;
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const q = new URLSearchParams();
    q.set('map', S.mapSource.param);
    q.set('x', S.cam.x.toFixed(1)); q.set('y', S.cam.y.toFixed(1)); q.set('z', (S.cam.s / PX).toFixed(3));
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }, 300);
}

async function browseMaps() {
  openModal('Browse maps', '<p class="hint">Loading lists…</p>');
  const groups = [];
  try {
    const repoList = await (await fetch('maps/index.json', { cache: 'no-cache' })).json();
    if (repoList.maps && repoList.maps.length) groups.push({ title: 'This repo', items: repoList.maps.map(p => ({ p: 'repo:maps/' + p, name: baseName(p), path: 'maps/' + p })) });
  } catch (e) { /* none */ }
  for (const l of await loadMapLists()) {
    const by = new Map();
    for (const p of l.maps) {
      const parts = p.split('/');
      const grp = parts.slice(1, -1).join('/') || 'Maps';
      if (!by.has(grp)) by.set(grp, []);
      by.get(grp).push({ p: l.id + ':' + p, name: baseName(p).replace(/\.yml$/, ''), path: p });
    }
    const order = [...by.keys()].sort((a, b) => (b.includes('Stations') - a.includes('Stations')) || a.localeCompare(b));
    for (const k of order) groups.push({ title: l.name + ' · ' + k, items: by.get(k) });
  }
  let html = '<input id="mapSearch" class="search" placeholder="Search maps…" style="width:100%;margin-bottom:6px">';
  html += groups.map(g => `<div class="group"><h3>${esc(g.title)}</h3><div class="maplist">${g.items.map(i =>
    `<button data-p="${esc(i.p)}" data-s="${esc((g.title + ' ' + i.path).toLowerCase())}"><div class="mn">${esc(i.name)}</div><div class="mp">${esc(i.path)}</div></button>`).join('')}</div></div>`).join('');
  if (!groups.length) html = '<p class="hint">No map lists found.</p>';
  $('#modalBody').innerHTML = html;
  $$('#modalBody .maplist button').forEach(b => b.onclick = () => { closeModal(); openFromParam(b.dataset.p); });
  const ms = $('#mapSearch');
  if (ms) {
    ms.focus();
    ms.oninput = () => {
      const q = ms.value.toLowerCase();
      $$('#modalBody .group').forEach(g => {
        let any = false;
        g.querySelectorAll('button').forEach(b => { const ok = !q || b.dataset.s.includes(q); b.hidden = !ok; any = any || ok; });
        g.hidden = !any;
      });
    };
  }
}
async function loadMapLists() {
  if (S.mapLists) return S.mapLists;
  const out = [];
  let sources = [];
  try { sources = (await (await fetch('sources.json', { cache: 'no-cache' })).json()).sources || []; } catch (e) { /* none */ }
  await Promise.all(sources.map(async (src, i) => {
    try {
      const j = await (await fetch(`db/maps-${src.id}.json`, { cache: 'no-cache' })).json();
      out[i] = { id: src.id, name: src.name || src.id, repo: j.repo || src.repo, commit: j.commit, maps: j.maps || [] };
    } catch (e) { /* none */ }
  }));
  S.mapLists = out.filter(Boolean);
  return S.mapLists;
}
function openModal(title, html) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }

// ---------------------------------------------------------------- camera & drawing
const cam = {
  toScreen(wx, wy) { return [(wx - S.cam.x) * S.cam.s + W / 2, -(wy - S.cam.y) * S.cam.s + H / 2]; },
  toWorld(sx, sy) { return [(sx - W / 2) / S.cam.s + S.cam.x, -(sy - H / 2) / S.cam.s + S.cam.y]; },
  get s() { return S.cam.s; },
};
function gridLocal(gr, wx, wy) {
  const dx = wx - gr.xf.x, dy = wy - gr.xf.y, c = Math.cos(-gr.xf.r), s = Math.sin(-gr.xf.r);
  return [dx * c - dy * s, dx * s + dy * c];
}
function gridWorld(gr, lx, ly) {
  const c = Math.cos(gr.xf.r), s = Math.sin(gr.xf.r);
  return [gr.xf.x + lx * c - ly * s, gr.xf.y + lx * s + ly * c];
}
function setGridXf(g, gr) {
  const s = S.cam.s, c = Math.cos(gr.xf.r), sn = Math.sin(gr.xf.r);
  g.setTransform(DPR * s * c, DPR * -s * sn, DPR * -s * sn, DPR * -s * c,
    DPR * (s * (gr.xf.x - S.cam.x) + W / 2), DPR * (-s * (gr.xf.y - S.cam.y) + H / 2));
}

function resize() {
  DPR = window.devicePixelRatio || 1;
  const r = $('#stage').getBoundingClientRect();
  W = r.width; H = r.height;
  for (const c of [mapCanvas, overlay]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  draw();
}

function fitView() {
  const r = S.renderer;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const gr of (r.grids || new Map()).values()) {
    if (!isFinite(gr.minX)) continue;
    for (const [lx, ly] of [[gr.minX, gr.minY], [gr.maxX, gr.minY], [gr.minX, gr.maxY], [gr.maxX, gr.maxY]]) {
      const [wx, wy] = gridWorld(gr, lx, ly);
      x0 = Math.min(x0, wx); y0 = Math.min(y0, wy); x1 = Math.max(x1, wx); y1 = Math.max(y1, wy);
    }
  }
  if (!isFinite(x0)) return;
  const pw = panelWidth();
  const aw = Math.max(200, W - pw - 80), ah = Math.max(200, H - 60);
  S.cam.s = Math.max(0.5, Math.min(64, Math.min(aw / (x1 - x0), ah / (y1 - y0))));
  S.cam.x = (x0 + x1) / 2 + (pw / 2) / S.cam.s;
  S.cam.y = (y0 + y1) / 2;
  draw();
}
function panelWidth() { return $('#panel').classList.contains('hidden') || W < 760 ? 0 : $('#panel').offsetWidth; }

let rafPending = false;
function draw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; drawNow(); });
}

function drawNow() {
  const g = mctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = S.bg;
  g.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
  const r = S.renderer;
  let pending = false;
  if (r.grids) {
    const t0 = performance.now();
    const useOverview = S.cam.s < 10;
    for (const gr of r.grids.values()) {
      // visible chunk range in grid-local space
      const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([sx, sy]) => gridLocal(gr, ...cam.toWorld(sx, sy)));
      const lx0 = Math.min(...corners.map(c => c[0])), lx1 = Math.max(...corners.map(c => c[0]));
      const ly0 = Math.min(...corners.map(c => c[1])), ly1 = Math.max(...corners.map(c => c[1]));
      setGridXf(g, gr);
      const ov = gr.ov;
      if (useOverview && ov) {
        g.save();
        g.imageSmoothingEnabled = S.cam.s < ov.op;
        g.translate(ov.x0, ov.y1);
        g.scale(1 / ov.op, -1 / ov.op);
        g.drawImage(ov.canvas, 0, 0);
        g.restore();
        // fill chunks the overview doesn't have yet
        for (const c of gr.chunks.values()) if (!ov.done.has(c) && performance.now() - t0 < 12) r.renderChunk(gr, c);
        for (const c of gr.chunks.values()) if (!ov.done.has(c)) { pending = true; break; }
        continue;
      }
      g.imageSmoothingEnabled = false;
      const cx0 = Math.floor(lx0 / CHUNK), cx1 = Math.floor(lx1 / CHUNK), cy0 = Math.floor(ly0 / CHUNK), cy1 = Math.floor(ly1 / CHUNK);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const c = gr.chunks.get(cx + ',' + cy);
        if (!c) continue;
        if (!c.canvas) {
          if (performance.now() - t0 > 14) {
            pending = true;
            // stand-in until the sharp chunk is drawn: just this chunk's part of the overview
            if (ov && ov.done.has(c)) {
              const sx = (cx * CHUNK - ov.x0) * ov.op, sy = (ov.y1 - (cy + 1) * CHUNK) * ov.op, sz = CHUNK * ov.op;
              g.save();
              g.imageSmoothingEnabled = true;
              g.translate(cx * CHUNK, (cy + 1) * CHUNK);
              g.scale(CHUNK / sz, -CHUNK / sz);
              g.drawImage(ov.canvas, sx, sy, sz, sz, 0, 0, sz, sz);
              g.restore();
            }
            continue;
          }
          r.renderChunk(gr, c);
        }
        c.used = performance.now();
        g.save();
        g.translate(cx * CHUNK, (cy + 1) * CHUNK);
        g.scale(1 / PX, -1 / PX);
        g.drawImage(c.canvas, 0, 0);
        g.restore();
      }
    }
    r.evict();
  }
  if (pending) draw();
  drawOverlay();
  $('#stZoom').textContent = Math.round(S.cam.s / PX * 100) + '%';
  syncUrl();
}

function drawOverlay(cursor) {
  const g = octx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, overlay.width, overlay.height);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const r = S.renderer;
  // tile grid
  if (S.showGrid && r.grids && S.cam.s >= 8) {
    for (const gr of r.grids.values()) {
      if (!isFinite(gr.minX)) continue;
      g.save();
      setGridXf(g, gr);
      g.strokeStyle = 'rgba(255,255,255,.10)';
      g.lineWidth = 1 / S.cam.s;
      g.beginPath();
      for (let x = Math.floor(gr.minX); x <= Math.ceil(gr.maxX); x++) { g.moveTo(x, gr.minY); g.lineTo(x, gr.maxY); }
      for (let y = Math.floor(gr.minY); y <= Math.ceil(gr.maxY); y++) { g.moveTo(gr.minX, y); g.lineTo(gr.maxX, y); }
      g.stroke();
      g.restore();
    }
  }
  // highlights
  if (S.highlight && r.grids) {
    g.save();
    for (const it of S.highlight.items) {
      const gr = r.grids.get(it.grid) || r.grids.get(0);
      if (!gr) continue;
      const [wx, wy] = gridWorld(gr, it.x, it.y);
      const [sx, sy] = cam.toScreen(wx, wy);
      const rad = Math.max(6, 0.55 * S.cam.s);
      g.strokeStyle = '#4fc3d9';
      g.lineWidth = 2;
      g.strokeRect(sx - rad, sy - rad, rad * 2, rad * 2);
    }
    g.restore();
  }
  // area selection
  if (S.area && S.area.tiles.size && r.grids) {
    const gr = r.grids.get(S.area.grid);
    if (gr) {
      g.save();
      setGridXf(g, gr);
      g.fillStyle = 'rgba(79,195,217,.16)';
      g.fill(S.area.fill);
      g.strokeStyle = '#4fc3d9';
      g.lineWidth = 2 / S.cam.s;
      g.stroke(S.area.edges);
      g.restore();
    }
  }
  if (S.areaDrag && r.grids) {
    const gr = r.grids.get(areaGrid());
    if (gr) {
      const [x0, y0, x1, y1] = areaRect(gr, S.areaDrag.a, S.areaDrag.b);
      g.save();
      setGridXf(g, gr);
      const col = S.areaDrag.mode === 'sub' ? '#ff5c8a' : S.areaDrag.mode === 'add' ? '#7bd88f' : '#f2b84b';
      g.fillStyle = col + '22';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = col;
      g.lineWidth = 2 / S.cam.s;
      g.setLineDash([5 / S.cam.s, 4 / S.cam.s]);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
      g.save();
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      const [sx, sy] = cam.toScreen(...gridWorld(gr, x1, y0));
      g.font = '600 12px "IBM Plex Mono", monospace';
      g.fillStyle = col;
      const sign = S.areaDrag.mode === 'sub' ? '− ' : S.areaDrag.mode === 'add' ? '+ ' : '';
      g.fillText(`${sign}${x1 - x0} × ${y1 - y0}`, sx + 6, sy + 14);
      g.restore();
    }
  }
  // selection
  const sel = S.selection;
  if (sel && r.grids) {
    const it = sel.hits[sel.idx] && sel.hits[sel.idx].it;
    if (it) {
      const gr = r.grids.get(it.grid) || r.grids.get(0);
      g.save();
      setGridXf(g, gr);
      g.strokeStyle = '#f2b84b';
      g.lineWidth = 2 / S.cam.s;
      g.setLineDash([4 / S.cam.s, 3 / S.cam.s]);
      const rr = Math.max(0.5, Math.min(it.rad || 0.5, 2));
      g.strokeRect(it.x - rr, it.y - rr, rr * 2, rr * 2);
      g.restore();
    } else if (sel.tile) {
      const gr = r.grids.get(sel.grid);
      if (gr) {
        g.save(); setGridXf(g, gr);
        g.strokeStyle = '#f2b84b'; g.lineWidth = 2 / S.cam.s;
        g.strokeRect(sel.tile.x, sel.tile.y, 1, 1);
        g.restore();
      }
    }
  }
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  annots.draw(g, cam);
  // eraser / pen cursor
  const cur = cursor || drawOverlay.lastCursor;
  if (cur && (S.tool === 'eraser' || S.tool === 'pen')) {
    const rad = S.tool === 'eraser' ? eraserRadiusPx() : Math.max(2, penWidth() * S.cam.s / 2);
    g.beginPath();
    g.arc(cur[0], cur[1], rad, 0, Math.PI * 2);
    g.strokeStyle = S.tool === 'eraser' ? '#fff' : S.color;
    g.lineWidth = 1.5;
    g.stroke();
  }
}
const penWidth = () => S.size * 0.08;               // world units (tiles)
const eraserRadiusPx = () => 6 + S.size * 3;

// ---------------------------------------------------------------- input
function setTool(t) {
  S.tool = t;
  $('#stage').dataset.tool = t;
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  drawOverlay();
}

function setupInput() {
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  overlay.addEventListener('pointerdown', (e) => {
    overlay.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: S.cam.s, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      drag = null;
      if (annots.cur) annots.endLine();
      return;
    }
    const panBtn = e.button === 1 || e.button === 2 || spaceDown;
    if (S.tool === 'pan' || panBtn) {
      drag = { kind: 'pan', x: e.offsetX, y: e.offsetY, cx: S.cam.x, cy: S.cam.y, moved: false };
      $('#stage').classList.add('dragging');
      return;
    }
    const [wx, wy] = cam.toWorld(e.offsetX, e.offsetY);
    if (S.tool === 'pick') {
      const mode = e.shiftKey ? 'add' : (e.altKey || e.ctrlKey || e.metaKey) ? 'sub' : 'new';
      drag = { kind: 'pick', x: e.offsetX, y: e.offsetY, w0: [wx, wy], mode, moved: false };
      e.preventDefault();
    }
    else if (S.tool === 'pen') { annots.beginLine(wx, wy, S.color, penWidth()); drag = { kind: 'pen' }; drawOverlay(); }
    else if (S.tool === 'eraser') { annots.beginErase(); annots.erase(wx, wy, eraserRadiusPx() / S.cam.s); drag = { kind: 'erase' }; }
    else if (S.tool === 'text') { e.preventDefault(); startText(e.offsetX, e.offsetY, wx, wy); }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    const [wx, wy] = cam.toWorld(e.offsetX, e.offsetY);
    $('#stCoords').textContent = coordText(wx, wy);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(pinch.mid[0], pinch.mid[1], (pinch.s * d / pinch.d) / S.cam.s);
      return;
    }
    drawOverlay.lastCursor = [e.offsetX, e.offsetY];
    if (!drag) { if (S.tool === 'eraser' || S.tool === 'pen') drawOverlay(); return; }
    if (drag.kind === 'pick') {
      if (Math.abs(e.offsetX - drag.x) + Math.abs(e.offsetY - drag.y) > 4) drag.moved = true;
      if (drag.moved) { S.areaDrag = { a: drag.w0, b: [wx, wy], mode: drag.mode }; drawOverlay(); }
    } else if (drag.kind === 'pan') {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      {
        S.cam.x = drag.cx - dx / S.cam.s;
        S.cam.y = drag.cy + dy / S.cam.s;
        draw();
      }
    } else if (drag.kind === 'pen') {
      annots.extendLine(wx, wy, 1.5 / S.cam.s);
      drawOverlay();
    } else if (drag.kind === 'erase') {
      annots.erase(wx, wy, eraserRadiusPx() / S.cam.s);
      drawOverlay();
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    if (drag.kind === 'pick') {
      S.areaDrag = null;
      if (!drag.moved) pickAt(e.offsetX, e.offsetY);
      else { const [wx, wy] = cam.toWorld(e.offsetX, e.offsetY); applyArea(drag.w0, [wx, wy], drag.mode); }
    }
    if (drag.kind === 'pen') annots.endLine();
    if (drag.kind === 'erase') annots.endErase();
    drag = null;
    $('#stage').classList.remove('dragging');
  };
  overlay.addEventListener('pointerup', end);
  overlay.addEventListener('pointercancel', end);
  overlay.addEventListener('pointerleave', () => { drawOverlay.lastCursor = null; drawOverlay(); });
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  overlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
    zoomAt(e.offsetX, e.offsetY, k);
  }, { passive: false });
  overlay.addEventListener('dblclick', (e) => { if (S.tool === 'pan' || S.tool === 'pick') zoomAt(e.offsetX, e.offsetY, e.shiftKey ? 0.5 : 2); });

  let spaceDown = false;
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? annots.redo() : annots.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); annots.redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') { spaceDown = true; e.preventDefault(); return; }
    if (k === 'f') fitView();
    else if (k === 'h') setTool('pan');
    else if (k === 'v') setTool('pick');
    else if (k === 'b' || k === 'p') setTool('pen');
    else if (k === 'e') setTool('eraser');
    else if (k === 't') setTool('text');
    else if (k === 'g') { S.showGrid = !S.showGrid; renderToggles(); drawOverlay(); }
    else if (k === '+' || k === '=') zoomAt(W / 2, H / 2, 1.25);
    else if (k === '-') zoomAt(W / 2, H / 2, 0.8);
    else if (k === 'escape') {
      if (S.selection || S.highlight) { S.selection = null; S.highlight = null; renderInspect(); }
      else clearArea();
      drawOverlay();
    }
    else if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.add(k); e.preventDefault(); startKeyPan(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') spaceDown = false;
    keys.delete(k);
  });
  let keyPan = false;
  function startKeyPan() {
    if (keyPan) return;
    keyPan = true;
    let last = performance.now();
    const step = (t) => {
      const dt = Math.min(50, t - last); last = t;
      let dx = 0, dy = 0;
      if (keys.has('w') || keys.has('arrowup')) dy += 1;
      if (keys.has('s') || keys.has('arrowdown')) dy -= 1;
      if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
      if (keys.has('d') || keys.has('arrowright')) dx += 1;
      if (!dx && !dy) { keyPan = false; return; }
      const sp = 700 / S.cam.s * dt / 1000;
      S.cam.x += dx * sp; S.cam.y += dy * sp;
      draw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  window.addEventListener('resize', resize);

  // drag and drop
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) {
      if (/\.json$/i.test(f.name)) importAnnots(f);
      else openFile(f);
    }
  });
}

function zoomAt(sx, sy, k) {
  const [wx, wy] = cam.toWorld(sx, sy);
  S.cam.s = Math.max(0.25, Math.min(256, S.cam.s * k));
  const [wx2, wy2] = cam.toWorld(sx, sy);
  S.cam.x += wx - wx2; S.cam.y += wy - wy2;
  draw();
}

function coordText(wx, wy) {
  const r = S.renderer;
  if (r.grids && S.model && S.model.grids.length) {
    const gr = r.grids.get(S.model.grids[0].uid);
    if (gr) { const [lx, ly] = gridLocal(gr, wx, wy); return `x ${lx.toFixed(2)}  y ${ly.toFixed(2)}`; }
  }
  return `x ${wx.toFixed(2)}  y ${wy.toFixed(2)}`;
}

// ---------------------------------------------------------------- text tool
function startText(sx, sy, wx, wy) {
  const ta = $('#textInput');
  const existing = annots.textAt(wx, wy);
  const size = Math.max(0.3, S.size * 0.25);
  let anchor = { x: wx, y: wy, size, color: S.color };
  if (existing) anchor = { x: existing.x, y: existing.y, size: existing.size, color: existing.color };
  const [ax, ay] = cam.toScreen(anchor.x, anchor.y);
  const fs = Math.max(12, anchor.size * S.cam.s);
  ta.style.left = ax + 'px'; ta.style.top = ay + 'px';
  ta.style.fontSize = fs + 'px'; ta.style.color = anchor.color;
  ta.value = existing ? existing.text : '';
  ta.hidden = false;
  ta.rows = Math.max(1, ta.value.split('\n').length);
  ta.focus();
  setTimeout(() => ta.focus(), 0);
  const done = (commit) => {
    ta.onkeydown = null; ta.onblur = null;
    ta.hidden = true;
    if (!commit) return;
    if (existing) annots.editText(existing, ta.value);
    else annots.addText(anchor.x, anchor.y, ta.value, anchor.color, anchor.size);
  };
  ta.oninput = () => { ta.rows = Math.max(1, ta.value.split('\n').length); ta.style.width = Math.max(80, ta.value.split('\n').reduce((m, l) => Math.max(m, l.length), 0) * fs * 0.6 + 20) + 'px'; };
  ta.oninput();
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  };
  ta.onblur = () => done(true);
}

// ---------------------------------------------------------------- picking & inspect
function pickAt(sx, sy) {
  const r = S.renderer;
  if (!r.grids) return;
  const [wx, wy] = cam.toWorld(sx, sy);
  let all = [], tile = null, tileGrid = null;
  for (const gr of r.grids.values()) {
    const [lx, ly] = gridLocal(gr, wx, wy);
    const res = r.pick(gr.uid, lx, ly);
    if (!res.hits) continue;
    all = all.concat(res.hits);
    if (res.tile && !tile) { tile = res.tile; tileGrid = gr.uid; }
  }
  const rank = (h) => (h.solid ? 2 : 0) + (h.it.kind === 'ent' ? 1 : 0);
  all.sort((a, b) => (rank(b) - rank(a)) || (b.it.order - a.it.order));
  S.selection = { hits: all, idx: 0, tile, grid: tileGrid, world: [wx, wy] };
  if (!all.length && !tile) S.selection = null;
  showTab('inspect');
  renderInspect();
  drawOverlay();
}

function frameCanvas(res, dir, scale, rect) {
  const c = document.createElement('canvas');
  const rr = rect || S.store.frameRect(res, dir || 0);
  c.width = rr.sw * scale; c.height = rr.sh * scale;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(res.img, rr.sx, rr.sy, rr.sw, rr.sh, 0, 0, c.width, c.height);
  return c;
}
function canvasBlob(c) { return new Promise(r => c.toBlob(r, 'image/png')); }

function itemPreview(it, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  const P = size / Math.max(1.0, Math.min(3, (it.rad || 0.5) * 2));
  const toPx = (x, y) => [size / 2 + (x - it.x) * P, size / 2 - (y - it.y) * P];
  S.renderer.drawItem(g, it, toPx, P);
  return c;
}

function viewSheet(res, title, path, fileName, select) {
  if (!res || !res.img) return;
  const states = res.state != null && !res.tex ? [{ name: res.state, dirs: res.dirs, frames: res.frames }] : null;
  openImageViewer({
    img: res.img, blob: res.blob, title, path, fileName,
    frameW: res.tex ? (res.img.width % PX === 0 && res.img.height === PX ? PX : res.img.width) : res.w,
    frameH: res.tex ? res.img.height : res.h,
    states, select, onToast: toast,
  });
}

function layerKey(l) { return l.tex ? 't:' + l.tex : (l.rsi + '|' + l.state + '|' + (l.fixedDir != null ? l.fixedDir : '')); }

function renderInspect() {
  const pane = $('#paneInspect');
  const sel = S.selection;
  if (!sel) {
    pane.innerHTML = '<p class="hint">Choose the <b>pick</b> tool (V) and click anything on the map to see its sprite, where it came from, and open its folder.</p>';
    return;
  }
  pane.innerHTML = '';
  const hit = sel.hits[sel.idx];
  if (hit) {
    const it = hit.it;
    const head = document.createElement('div');
    head.className = 'ihead';
    head.appendChild(itemPreview(it, 72));
    const gr = S.renderer.grids.get(it.grid);
    head.insertAdjacentHTML('beforeend', `<div><h2>${esc(it.name)}</h2><div class="id">${esc(it.proto)}</div>
      <dl class="kv" style="margin:6px 0 0">
        ${it.uid != null ? `<span class="k">uid</span><span class="v">${it.uid}</span>` : ''}
        <span class="k">pos</span><span class="v">${it.x.toFixed(2)}, ${it.y.toFixed(2)}${gr && gr.uid ? ' on ' + esc(gr.name) : ''}</span>
        <span class="k">rot</span><span class="v">${Math.round(it.rot * 180 / Math.PI)}°</span>
        <span class="k">depth</span><span class="v">${it.kind === 'decal' ? 'decal' : it.depth}</span>
      </dl></div>`);
    pane.appendChild(head);
    if (it.renamedFrom) pane.insertAdjacentHTML('beforeend', `<p class="hint">Saved in the map as <code>${esc(it.renamedFrom)}</code>, which the game renames to this.</p>`);
    if (it.unknown) pane.insertAdjacentHTML('beforeend', `<p class="hint" style="color:var(--bad)">This ${it.kind === 'decal' ? 'decal' : 'prototype'} is not in the sprite database (${esc(S.db.repo || '')}), so it is drawn with the dev texture.</p>`);
    const btns = document.createElement('div');
    btns.className = 'row gap wrap';
    const count = S.scene.items.filter(x => x.proto === it.proto && x.kind === it.kind).length;
    btns.innerHTML = `<button class="btn small" data-a="hl">Highlight all ${count}</button><button class="btn small" data-a="copyid">Copy id</button>`;
    btns.querySelector('[data-a=hl]').onclick = () => highlightProto(it.proto, it.kind);
    btns.querySelector('[data-a=copyid]').onclick = () => copyText(it.proto);
    pane.appendChild(btns);

    const seen = new Set();
    const cards = (layers, target) => {
      for (const l of layers) {
        if (l.dev) continue;
        const k = layerKey(l);
        if (seen.has(k)) continue;
        seen.add(k);
        target.appendChild(layerCard(it, l));
      }
    };
    if (it.alt) {
      // both looks side by side, then the layers of each
      const both = document.createElement('div');
      both.className = 'looks';
      for (const [label, layers] of [[it.placedLabel, it.layers], [it.alt.label, it.alt.layers]]) {
        const f = document.createElement('figure');
        f.appendChild(itemPreview({ ...it, layers }, 72));
        f.insertAdjacentHTML('beforeend', `<figcaption>${esc(label)}</figcaption>`);
        both.appendChild(f);
      }
      pane.insertAdjacentHTML('beforeend', '<h3>Placed and loose</h3>');
      pane.appendChild(both);
      pane.insertAdjacentHTML('beforeend', `<h3>Sprite layers · ${esc(it.placedLabel.toLowerCase())}</h3>`);
      cards(it.layers, pane);
      pane.insertAdjacentHTML('beforeend', `<h3>Sprite layers · ${esc(it.alt.label.toLowerCase())}</h3>`);
      const box = document.createElement('div');
      cards(it.alt.layers, box);
      if (!box.children.length) box.innerHTML = '<p class="hint">Same sprites as above.</p>';
      pane.appendChild(box);
    } else {
      pane.insertAdjacentHTML('beforeend', '<h3>Sprite layers</h3>');
      cards(it.layers, pane);
    }
    if (sel.hits.length > 1) {
      pane.insertAdjacentHTML('beforeend', `<h3>Also here <span class="badge">${sel.hits.length}</span></h3>`);
      const box = document.createElement('div');
      box.className = 'others';
      sel.hits.forEach((h, i) => {
        const b = document.createElement('button');
        if (i === sel.idx) b.className = 'cur';
        b.innerHTML = `<span>${esc(h.it.name)}</span><span class="d">${esc(h.it.proto)}</span>`;
        b.onclick = () => { sel.idx = i; renderInspect(); drawOverlay(); };
        box.appendChild(b);
      });
      pane.appendChild(box);
    }
  }
  if (sel.tile) {
    const t = sel.tile;
    pane.insertAdjacentHTML('beforeend', `<h3>Floor tile</h3>`);
    const card = document.createElement('div');
    card.className = 'layer';
    const res = t.res;
    const path = t.td && t.td.s ? texRel(t.td.s) : null;
    const lt = document.createElement('div');
    lt.className = 'lt';
    if (res) lt.appendChild(frameCanvas(res, 0, 1, { sx: 0, sy: 0, sw: Math.min(res.img.width, 32), sh: Math.min(res.img.height, 32) }));
    lt.insertAdjacentHTML('beforeend', `<div><div class="path">${esc(t.name)}</div><div class="path">${esc(path || '(not in database)')}</div>
      <div class="src">${res && !res.dev ? 'from <b>' + esc(res.pack.name) + '</b>' : '<b class="bad">missing → dev texture</b>'} · variant ${t.v}</div></div>`);
    card.appendChild(lt);
    if (res && !res.dev) {
      const fb = fileButtons(res.pack, path, res.blob, baseName(path), path.split('/').slice(0, -1).join('/'));
      const vb = document.createElement('button');
      vb.className = 'btn small primary'; vb.textContent = 'View sheet';
      const vsel = { x: Math.min(t.v, Math.floor(res.img.width / PX) - 1) * PX, y: 0, w: PX, h: Math.min(PX, res.img.height) };
      vb.onclick = () => openImageViewer({ img: res.img, blob: res.blob, title: t.name, path, fileName: baseName(path),
        frameW: PX, frameH: Math.min(PX, res.img.height), select: vsel, onToast: toast });
      fb.prepend(vb);
      card.appendChild(fb);
    }
    pane.appendChild(card);
  }
}

function fileButtons(pack, relFile, blob, fileName, relDir, metaBlobFn) {
  const btns = document.createElement('div');
  btns.className = 'btns';
  const link = pack.link(relDir, true);
  if (link) btns.insertAdjacentHTML('beforeend', `<a class="btn small" href="${esc(link)}" target="_blank" rel="noopener">Open folder ↗</a>`);
  const bPath = document.createElement('button');
  bPath.className = 'btn small'; bPath.textContent = 'Copy path';
  bPath.onclick = () => copyText(pack.displayPath(relDir));
  btns.appendChild(bPath);
  if (blob) {
    const bCopy = document.createElement('button');
    bCopy.className = 'btn small'; bCopy.textContent = 'Copy PNG';
    bCopy.onclick = () => copyImage(blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' }));
    btns.appendChild(bCopy);
    const bDl = document.createElement('button');
    bDl.className = 'btn small'; bDl.textContent = 'Download';
    bDl.onclick = () => download(blob, fileName);
    btns.appendChild(bDl);
  }
  if (metaBlobFn) {
    const bM = document.createElement('button');
    bM.className = 'btn small'; bM.textContent = 'meta.json';
    bM.onclick = async () => { const b = await metaBlobFn(); if (b) download(b, 'meta.json'); };
    btns.appendChild(bM);
  }
  return btns;
}

function layerCard(it, l) {
  const card = document.createElement('div');
  card.className = 'layer';
  const res = l.res;
  const lt = document.createElement('div');
  lt.className = 'lt';
  if (res) {
    const p = S.renderer.placement(it, l);
    const c = frameCanvas(res, 0, 1, p.rect);
    const sc = Math.max(1, Math.floor(48 / Math.max(c.width, c.height)));
    c.style.width = c.width * sc + 'px'; c.style.height = c.height * sc + 'px';
    if (!res.dev) {
      c.style.cursor = 'zoom-in';
      c.title = 'Open the whole sprite sheet';
      c.onclick = () => viewSheet(res, l.tex ? baseName(l.tex) : `${l.state}`, l.tex ? texRel(l.tex) : texRel(l.rsi) + '/' + l.state + '.png',
        l.tex ? baseName(l.tex) : l.state + '.png', { x: p.rect.sx, y: p.rect.sy, w: p.rect.sw, h: p.rect.sh });
    }
    lt.appendChild(c);
  }
  const path = l.tex ? texRel(l.tex) : texRel(l.rsi);
  const vis = S.renderer.layerVisible(l);
  lt.insertAdjacentHTML('beforeend', `<div style="min-width:0"><div class="path">${esc(path)}</div>
    ${l.tex ? '' : `<div class="path">state <b>${esc(l.state)}</b>${l.connector ? ' · pipe connector' : l.fixedDir != null ? ' · corner' : ''}</div>`}
    <div class="src">${res && !res.dev ? 'from <b>' + esc(res.pack.name) + '</b>' : '<b class="bad">missing → dev texture</b>'}${!vis ? ' · hidden in game' : ''}${l.color ? ' · tint ' + esc(l.color) : ''}</div></div>`);
  card.appendChild(lt);
  if (res && !res.dev) {
    const relDir = l.tex ? path.split('/').slice(0, -1).join('/') : path;
    const file = l.tex ? path : path + '/' + l.state + '.png';
    const fb = fileButtons(res.pack, file, res.blob, l.tex ? baseName(path) : l.state + '.png', relDir,
      l.tex ? null : async () => new Blob([JSON.stringify(res.metaRaw, null, 2)], { type: 'application/json' }));
    const vb = document.createElement('button');
    vb.className = 'btn small primary'; vb.textContent = 'View sheet';
    vb.title = 'Open the whole PNG: zoom, select frames, copy';
    vb.onclick = () => lt.querySelector('canvas').onclick();
    fb.prepend(vb);
    card.appendChild(fb);
    if (!l.tex && res.metaRaw) {
      const more = document.createElement('details');
      more.innerHTML = `<summary class="hint" style="cursor:pointer;margin:8px 0 0">All ${res.metaRaw.states.length} states in this RSI</summary>`;
      more.ontoggle = async () => {
        if (!more.open || more.dataset.done) return;
        more.dataset.done = 1;
        const grid = document.createElement('div');
        grid.className = 'states';
        more.appendChild(grid);
        for (const st of res.metaRaw.states) {
          const fig = document.createElement('figure');
          if (st.name === l.state) fig.className = 'cur';
          fig.title = 'Open this sheet';
          grid.appendChild(fig);
          S.store.state(l.rsi, st.name).then(r2 => {
            const c = frameCanvas(r2, 0, 1);
            fig.prepend(c);
            fig.insertAdjacentHTML('beforeend', `<figcaption>${esc(st.name)}${st.directions > 1 ? ' ·' + st.directions + 'd' : ''}${r2.dev ? ' ✕' : ''}</figcaption>`);
            fig.onclick = () => r2.dev ? toast('Not in any pack', true) : viewSheet(r2, st.name, texRel(l.rsi) + '/' + st.name + '.png', st.name + '.png');
          });
        }
      };
      card.appendChild(more);
    }
  }
  return card;
}

function highlightProto(proto, kind) {
  const items = S.scene.items.filter(x => x.proto === proto && (!kind || x.kind === kind));
  S.highlight = { label: proto, items };
  drawOverlay();
  toast(`${items.length} × ${proto} highlighted (Esc to clear)`);
}

// ---------------------------------------------------------------- area selection
// The selection is a set of whole tiles on the map's main grid. Plain drag replaces it,
// Shift+drag adds, Alt/Ctrl+drag removes. Counts only cover layers that are shown.
function areaGrid() {
  if (S.area && S.area.grid != null) return S.area.grid;
  let best = null, n = -1;
  for (const g of (S.model ? S.model.grids : [])) if (g.chunks.length > n) { n = g.chunks.length; best = g.uid; }
  return best != null ? best : 0;
}
function areaRect(gr, a, b) {
  const [ax, ay] = gridLocal(gr, a[0], a[1]), [bx, by] = gridLocal(gr, b[0], b[1]);
  const x0 = Math.floor(Math.min(ax, bx)), y0 = Math.floor(Math.min(ay, by));
  const x1 = Math.max(x0 + 1, Math.ceil(Math.max(ax, bx))), y1 = Math.max(y0 + 1, Math.ceil(Math.max(ay, by)));
  return [x0, y0, x1, y1];
}
function applyArea(a, b, mode) {
  const r = S.renderer;
  if (!r.grids) return;
  const grid = areaGrid();
  const gr = r.grids.get(grid);
  if (!gr) return;
  if (!S.area || mode === 'new') S.area = { grid, tiles: new Set() };
  const [x0, y0, x1, y1] = areaRect(gr, a, b);
  if ((x1 - x0) * (y1 - y0) > 4e6) { toast('That area is too large', true); return; }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const k = x + ',' + y;
    if (mode === 'sub') S.area.tiles.delete(k); else S.area.tiles.add(k);
  }
  buildAreaPaths();
  renderArea();
  showTab('area');
  drawOverlay();
}
function clearArea() { S.area = null; renderArea(); drawOverlay(); }
function buildAreaPaths() {
  const fill = new Path2D(), edges = new Path2D();
  const t = S.area.tiles;
  const rows = new Map();
  for (const k of t) {
    const i = k.indexOf(',');
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
    if (!t.has(x + ',' + (y + 1))) { edges.moveTo(x, y + 1); edges.lineTo(x + 1, y + 1); }
    if (!t.has(x + ',' + (y - 1))) { edges.moveTo(x, y); edges.lineTo(x + 1, y); }
    if (!t.has((x - 1) + ',' + y)) { edges.moveTo(x, y); edges.lineTo(x, y + 1); }
    if (!t.has((x + 1) + ',' + y)) { edges.moveTo(x + 1, y); edges.lineTo(x + 1, y + 1); }
  }
  for (const [y, xs] of rows) {           // one rectangle per run of tiles in a row
    xs.sort((p, q) => p - q);
    let st = xs[0], pr = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === pr + 1) { pr = xs[i]; continue; }
      fill.rect(st, y, pr - st + 1, 1);
      if (i < xs.length) { st = pr = xs[i]; }
    }
  }
  S.area.fill = fill; S.area.edges = edges;
}
function inArea(gridUid, lx, ly) {
  const r = S.renderer, a = S.area;
  let x = lx, y = ly;
  if (gridUid !== a.grid) {
    const from = r.grids.get(gridUid) || r.grids.get(0), to = r.grids.get(a.grid);
    if (!from || !to) return false;
    [x, y] = gridLocal(to, ...gridWorld(from, lx, ly));
  }
  return a.tiles.has(Math.floor(x) + ',' + Math.floor(y));
}
function areaContents() {
  const r = S.renderer, o = r.opts;
  const ents = new Map(), tiles = new Map(), decals = new Map();
  let total = 0;
  for (const it of S.scene.items) {
    if (!r.visible(it)) continue;
    if (!inArea(it.grid, it.x, it.y)) continue;
    const m = it.kind === 'decal' ? decals : ents;
    const key = it.proto;
    if (!m.has(key)) m.set(key, { id: key, name: it.kind === 'decal' ? '' : it.name, cat: it.kind === 'decal' ? 'decal' : it.marker ? 'markers' : (it.cat || 'other'), n: 0, items: [] });
    const e = m.get(key);
    e.n++; e.items.push(it);
    if (it.kind !== 'decal') total++;
  }
  if (o.tiles) for (const [g, list] of S.scene.tiles) for (const t of list) {
    if (!inArea(g, t.x + 0.5, t.y + 0.5)) continue;
    if (!tiles.has(t.name)) tiles.set(t.name, { id: t.name, name: (t.td && t.td.n) || '', n: 0 });
    tiles.get(t.name).n++;
  }
  return { ents, tiles, decals, total };
}
const CAT_LABEL = { atmos: 'atmos', hv: 'HV', mv: 'MV', lv: 'LV', disposal: 'disposal', walls: 'walls', doors: 'doors',
  wallmount: 'wall-mounted', machines: 'machines', storage: 'storage', furniture: 'furniture', items: 'items', other: 'other', markers: 'marker' };
function renderArea() {
  const pane = $('#paneArea');
  if (!pane) return;
  if (!S.area || !S.area.tiles.size || !S.scene) {
    S.areaResult = null;
    pane.innerHTML = `<p class="hint">With the <b>pick</b> tool (V), <b>drag</b> on the map to select an area.
      <b>Shift+drag</b> adds to it, <b>Alt+drag</b> or <b>Ctrl+drag</b> removes from it. <b>Esc</b> clears it.</p>
      <p class="hint">Everything inside that is on a shown layer (View tab) is listed here with counts.</p>`;
    return;
  }
  const res = areaContents();
  S.areaResult = res;
  const sorted = (m) => [...m.values()].sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const ents = sorted(res.ents), tiles = sorted(res.tiles), decals = sorted(res.decals);
  const nDec = decals.reduce((a, d) => a + d.n, 0), nTil = tiles.reduce((a, d) => a + d.n, 0);
  pane.innerHTML = `
    <div class="kv">
      <span class="k">area</span><span class="v">${S.area.tiles.size} tiles</span>
      <span class="k">objects</span><span class="v">${res.total} (${ents.length} kinds)</span>
      <span class="k">floor tiles</span><span class="v">${nTil}</span>
      <span class="k">decals</span><span class="v">${nDec}</span>
    </div>
    <div class="row gap wrap">
      <button class="btn small" data-a="copy">Copy list</button>
      <button class="btn small" data-a="csv">Download .csv</button>
      <button class="btn small" data-a="clear">Clear selection</button>
    </div>
    <p class="hint" style="margin-top:8px">Only layers shown in the View tab are counted. Click a row to highlight those objects.</p>
    <input class="search" id="areaFilter" placeholder="Filter…">
    <div id="areaLists"></div>`;
  const lists = pane.querySelector('#areaLists');
  const section = (title, rows, withCat) => {
    if (!rows.length) return;
    lists.insertAdjacentHTML('beforeend', `<h3>${esc(title)} <span class="badge">${rows.reduce((a, r) => a + r.n, 0)}</span></h3>`);
    const box = document.createElement('div');
    box.className = 'plist tall';
    for (const r of rows) {
      const b = document.createElement('button');
      b.dataset.s = (r.id + ' ' + r.name).toLowerCase();
      b.innerHTML = `<span><div class="n">${esc(r.id)}</div><div class="s">${esc(r.name)}${withCat && r.cat ? ' · ' + esc(CAT_LABEL[r.cat] || r.cat) : ''}</div></span><span class="c">${r.n}</span>`;
      if (r.items) b.onclick = () => { S.highlight = { label: r.id, items: r.items }; drawOverlay(); };
      box.appendChild(b);
    }
    lists.appendChild(box);
  };
  section('Objects', ents, true);
  section('Floor tiles', tiles, false);
  section('Decals', decals, false);
  pane.querySelector('#areaFilter').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    lists.querySelectorAll('.plist button').forEach(b => { b.hidden = q && !b.dataset.s.includes(q); });
  };
  const rowsOut = () => [
    ...ents.map(r => ['object', r.id, r.name, CAT_LABEL[r.cat] || r.cat, r.n]),
    ...tiles.map(r => ['tile', r.id, r.name, '', r.n]),
    ...decals.map(r => ['decal', r.id, '', '', r.n]),
  ];
  pane.querySelector('[data-a=copy]').onclick = () => copyText(rowsOut().map(r => `${r[1]}\t${r[4]}`).join('\n'));
  pane.querySelector('[data-a=csv]').onclick = () => {
    const q = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const csv = [['type', 'id', 'name', 'group', 'count'], ...rowsOut()].map(r => r.map(q).join(',')).join('\n') + '\n';
    download(new Blob([csv], { type: 'text/csv' }), safeName((S.model && S.model.name) || 'map') + '-area.csv');
  };
  pane.querySelector('[data-a=clear]').onclick = clearArea;
}

// ---------------------------------------------------------------- panes
function showTab(name) {
  $$('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  if ($('#panel').classList.contains('hidden')) togglePanel(true);
}
function togglePanel(show) {
  $('#panel').classList.toggle('hidden', !show);
  $('#btnExpand').hidden = show;
}

function renderPacks() {
  const ol = $('#packList');
  ol.innerHTML = '';
  const objs = S.packObjs || [];
  S.packCfgs.forEach((c, i) => {
    const li = document.createElement('li');
    if (c.enabled === false) li.className = 'off';
    const o = objs[i];
    let src = '';
    if (c.type === 'github') src = `${c.repo} @ ${c.ref === '{db}' ? 'database commit' : (c.ref || 'master')} · ${c.path || ''}`;
    else if (c.type === 'site') src = `this repo · ${c.path}`;
    else if (c.type === 'local') src = `folder · ${c.folder || ''} · ${c.files ? c.files.size : 0} files`;
    li.innerHTML = `<span class="num">${i + 1}</span>
      <div><div class="pn">${esc(c.name)}</div><div class="ps">${esc(src)}</div>${o && S.model ? `<div class="hits">${o.hits} sprites used</div>` : ''}</div>
      <div class="acts">
        <input type="checkbox" title="Use this pack" ${c.enabled !== false ? 'checked' : ''}>
        <button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button>
        ${c.type === 'local' ? '<button data-a="upload" title="Upload this folder into the repo as a pack">⇪</button>' : ''}
        <button data-a="del" title="Remove">✕</button>
      </div>`;
    li.querySelector('input').onchange = (e) => { c.enabled = e.target.checked; applyPacks(); };
    li.querySelector('[data-a=up]').onclick = () => { if (i > 0) { S.packCfgs.splice(i - 1, 0, S.packCfgs.splice(i, 1)[0]); applyPacks(); } };
    li.querySelector('[data-a=down]').onclick = () => { if (i < S.packCfgs.length - 1) { S.packCfgs.splice(i + 1, 0, S.packCfgs.splice(i, 1)[0]); applyPacks(); } };
    li.querySelector('[data-a=del]').onclick = () => { S.packCfgs.splice(i, 1); applyPacks(); };
    const up = li.querySelector('[data-a=upload]');
    if (up) up.onclick = () => uploadPack(c);
    ol.appendChild(li);
  });
  const dev = document.createElement('li');
  dev.className = 'dev';
  const devCount = S.missing ? [...S.missing.values()].reduce((a, m) => a + m.count, 0) : 0;
  dev.innerHTML = `<span class="num">∞</span><div><div class="pn">${esc(DEV.name)}</div><div class="ps">#FF00DC / black checker · catches everything else</div>${S.model ? `<div class="hits" style="color:var(--bad)">${devCount} uses</div>` : ''}</div><div></div>`;
  ol.appendChild(dev);
}

// layer tree for the View tab. Leaves are keys in renderer.opts.
const LAYER_TREE = [
  { k: 'tiles', label: 'Floor tiles' },
  { k: 'decals', label: 'Decals', sub: 'floor markings, dirt, flora' },
  { id: 'pipes', label: 'Pipes and cables', children: [
    { k: 'atmos', label: 'Atmos', sub: 'pipes, vents, scrubbers, pumps' },
    { id: 'electric', label: 'Electric', children: [
      { k: 'hv', label: 'HV cables' },
      { k: 'mv', label: 'MV cables' },
      { k: 'lv', label: 'LV cables' },
    ] },
    { k: 'disposal', label: 'Disposal pipes' },
  ] },
  { id: 'objects', label: 'Objects', children: [
    { k: 'walls', label: 'Walls', sub: 'walls, windows, grilles' },
    { k: 'doors', label: 'Airlocks and doors', sub: 'airlocks, firelocks, shutters, blast doors' },
    { k: 'wallmount', label: 'Wall-mounted', sub: 'lights, APCs, air and fire alarms, cameras, signs' },
    { k: 'machines', label: 'Machines and computers', sub: 'consoles, lathes, vending, power, thrusters' },
    { k: 'storage', label: 'Storage', sub: 'lockers, closets, crates, racks, tanks, canisters' },
    { k: 'furniture', label: 'Furniture', sub: 'tables, chairs, beds, sofas, carpets, plants' },
    { k: 'items', label: 'Items', sub: 'loose things lying around' },
    { k: 'other', label: 'Everything else', sub: 'catwalks, disposal units, conveyors, flora…' },
  ] },
  { k: 'markers', label: 'Markers and spawners', sub: 'only visible to mappers in game' },
];
const leaves = (n) => n.children ? n.children.flatMap(leaves) : [n.k];

function layerCounts() {
  const c = {};
  if (!S.scene) return c;
  for (const it of S.scene.items) {
    const k = it.kind === 'decal' ? 'decals' : it.marker ? 'markers' : (it.cat || 'other');
    c[k] = (c[k] || 0) + 1;
  }
  c.tiles = [...S.scene.tiles.values()].reduce((a, l) => a + l.length, 0);
  return c;
}

function applyOpts() {
  LS.set('opts', S.renderer.opts);
  renderArea();
  S.renderer.invalidate();
  backgroundFill(S.loadToken);
  draw();
  renderToggles();
}

function renderToggles() {
  const box = $('#toggles');
  box.innerHTML = '';
  const o = S.renderer.opts;
  const counts = layerCounts();
  const open = LS.get('openGroups', {});
  const row = (node, depth) => {
    const keys = leaves(node);
    const on = keys.filter(k => o[k]).length;
    const n = keys.reduce((a, k) => a + (counts[k] || 0), 0);
    const l = document.createElement('div');
    const isOpen = !!open[node.id];
    l.className = 'tg' + (node.children ? ' grp' : '');
    l.style.paddingLeft = (depth * 18) + 'px';
    l.innerHTML = `${node.children ? `<button class="fold${isOpen ? ' open' : ''}" title="${isOpen ? 'Fold' : 'Unfold'}">▸</button>` : '<span class="foldsp"></span>'}
      <label><input type="checkbox"><span>${esc(node.label)}${node.sub ? `<small>${esc(node.sub)}</small>` : ''}</span></label>
      ${S.scene ? `<span class="cnt">${n}</span>` : ''}<button class="only" title="Show only this">only</button>`;
    const cb = l.querySelector('input');
    cb.checked = on === keys.length;
    cb.indeterminate = on > 0 && on < keys.length;
    cb.onchange = () => { for (const k of keys) o[k] = cb.checked; applyOpts(); };
    l.querySelector('.only').onclick = () => { for (const k of LAYER_KEYS) o[k] = keys.includes(k); applyOpts(); };
    const fold = l.querySelector('.fold');
    if (fold) fold.onclick = () => { open[node.id] = !isOpen; LS.set('openGroups', open); renderToggles(); };
    box.appendChild(l);
    if (node.children && isOpen) for (const c of node.children) row(c, depth + 1);
  };
  for (const n of LAYER_TREE) row(n, 0);

  const opt = (key, label, sub, get, set) => {
    const l = document.createElement('div');
    l.className = 'tg opt';
    l.innerHTML = `<label><input type="checkbox" ${get() ? 'checked' : ''}><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
    l.querySelector('input').onchange = (e) => set(e.target.checked);
    box.appendChild(l);
  };
  box.insertAdjacentHTML('beforeend', '<div class="tgsep"></div>');
  opt('coverHide', 'Hide pipes and cables under floor tiles', 'as in game; only while floor tiles are shown',
    () => o.coverHide, (v) => { o.coverHide = v; applyOpts(); });
  opt('allLayers', 'Every sprite layer', 'also layers the game turns off (welded, bolted, panels…)',
    () => o.allLayers, (v) => { o.allLayers = v; applyOpts(); });
  opt('grid', 'Tile grid', 'key G', () => S.showGrid, (v) => { S.showGrid = v; drawOverlay(); });
  const all = document.createElement('div');
  all.className = 'row gap';
  all.innerHTML = '<button class="btn small" data-a="all">Show all</button><button class="btn small" data-a="def">Defaults</button>';
  all.querySelector('[data-a=all]').onclick = () => { for (const k of LAYER_KEYS) o[k] = true; applyOpts(); };
  all.querySelector('[data-a=def]').onclick = () => { Object.assign(o, DEFAULT_OPTS); applyOpts(); };
  box.appendChild(all);
}

function renderMapPane() {
  const m = S.model;
  if (!m) return;
  const tileCount = [...S.scene.tiles.values()].reduce((a, l) => a + l.length, 0);
  const ents = S.scene.items.filter(i => i.kind === 'ent').length;
  $('#mapInfo').innerHTML = `
    <span class="k">name</span><span class="v">${esc(m.name)}</span>
    <span class="k">source</span><span class="v">${esc(S.mapSource.label || S.mapSource.name)}</span>
    <span class="k">grids</span><span class="v">${m.grids.map(g => esc(g.name)).join(', ') || '–'}</span>
    <span class="k">tiles</span><span class="v">${tileCount}</span>
    <span class="k">objects</span><span class="v">${ents} drawn of ${m.entityCount} in file</span>
    <span class="k">decals</span><span class="v">${m.decals.length}</span>
    ${m.meta.engineVersion ? `<span class="k">engine</span><span class="v">${esc(m.meta.engineVersion)}</span>` : ''}
    <span class="k">database</span><span class="v">${esc(S.db.repo || '')} ${esc((S.db.commit || '').slice(0, 7))}</span>`;
  // proto counts
  const counts = new Map();
  for (const it of S.scene.items) {
    if (it.kind !== 'ent') continue;
    const c = counts.get(it.proto) || { n: 0, name: it.name };
    c.n++;
    counts.set(it.proto, c);
  }
  S.protoCounts = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  renderProtoList();
  // missing
  const ml = $('#missList');
  const miss = [...(S.missing || new Map()).values()].sort((a, b) => b.count - a.count);
  $('#missCount').textContent = miss.length;
  $('#missCount').className = 'badge' + (miss.length ? ' bad' : '');
  ml.innerHTML = '';
  if (!miss.length) ml.innerHTML = '<p class="hint" style="padding:8px">Nothing missing.</p>';
  for (const mm of miss.slice(0, 500)) {
    const b = document.createElement('button');
    const label = mm.protoUnknown ? `unknown proto ${mm.protoUnknown}` : mm.tileUnknown ? `unknown tile ${mm.tileUnknown}` :
      mm.tex ? mm.tex : `${mm.rsi} · ${mm.state}`;
    const sub = mm.protos && mm.protos.size ? [...mm.protos].slice(0, 3).join(', ') + (mm.protos.size > 3 ? '…' : '') : (mm.tile || '');
    b.innerHTML = `<span><div class="n">${esc(label)}</div><div class="s">${esc(sub)}</div></span><span class="c">${mm.count}</span>`;
    b.onclick = () => {
      if (mm.items && mm.items.length) { S.highlight = { label, items: mm.items }; drawOverlay(); toast(`${mm.items.length} highlighted (Esc to clear)`); }
    };
    ml.appendChild(b);
  }
}
function renderProtoList() {
  const box = $('#protoList');
  const q = $('#protoFilter').value.trim().toLowerCase();
  const list = (S.protoCounts || []).filter(([p, c]) => !q || p.toLowerCase().includes(q) || String(c.name).toLowerCase().includes(q));
  box.innerHTML = '';
  for (const [p, c] of list.slice(0, 400)) {
    const b = document.createElement('button');
    b.innerHTML = `<span><div class="n">${esc(p)}</div><div class="s">${esc(c.name)}</div></span><span class="c">${c.n}</span>`;
    b.onclick = () => highlightProto(p, 'ent');
    box.appendChild(b);
  }
  if (list.length > 400) box.insertAdjacentHTML('beforeend', `<p class="hint" style="padding:8px">${list.length - 400} more – type to filter</p>`);
}

function renderRepoInfo() {
  const repo = S.config.repo;
  $('#repoInfo').innerHTML = repo ? `
    <span class="k">repo</span><span class="v"><a href="https://github.com/${esc(repo)}" target="_blank" rel="noopener">${esc(repo)}</a></span>
    <span class="k">branch</span><span class="v">${esc(S.config.branch)}</span>
    <span class="k">database</span><span class="v">${esc(S.db.repo || '')} @ ${esc((S.db.commit || '').slice(0, 10))}<br>built ${esc(S.db.built || '?')}</span>
    <span class="k">update</span><span class="v"><a href="https://github.com/${esc(repo)}/actions/workflows/update-db.yml" target="_blank" rel="noopener">rebuild database ↗</a></span>`
    : '<span class="k">repo</span><span class="v">not configured (set "repo" in config.json)</span>';
  $('#ghToken').value = gh && gh.token ? '••••••••' : '';
  $('#tokenStatus').textContent = gh && gh.token ? 'A token is saved in this browser.' : 'No token saved – the site is read-only.';
}

function updateDrawStats() {
  const n = annots.items.length;
  const lines = annots.items.filter(i => i.t === 'line').length;
  $('#drawStats').textContent = `${lines} line${lines === 1 ? '' : 's'}, ${n - lines} text${n - lines === 1 ? '' : 's'} on this map.`;
  $('#btnDrawToggle').textContent = annots.visible ? 'Hide drawings' : 'Show drawings';
}
function saveAnnotsLocal() { if (S.mapSource) LS.set('draw.' + mapKey(), annots.toJSON()); }
async function loadAnnotsLocal() {
  const d = LS.get('draw.' + mapKey(), null);
  annots.load(d && d.items ? d.items : []);
  // drawings committed to the repo for this map
  if ((!d || !d.items || !d.items.length) && S.mapSource) {
    try {
      const r = await fetch('annotations/' + encodeURIComponent(safeName(mapKey())) + '.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); if (j.items && j.items.length) { annots.load(j.items); toast('Loaded drawings saved in the repo'); } }
    } catch (e) { /* none */ }
  }
  updateDrawStats();
}
async function importAnnots(file) {
  try {
    const j = JSON.parse(await file.text());
    annots.snapshot();
    annots.items = annots.items.concat(j.items || []);
    annots.onChange();
    toast('Drawings imported');
  } catch (e) { toast('Not a drawings file', true); }
}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

// ---------------------------------------------------------------- GitHub writes
function needToken() {
  if (gh && gh.ready) return false;
  showTab('repo');
  toast('Add a GitHub token in the Repo tab first', true);
  return true;
}
async function uploadPack(cfg) {
  if (needToken()) return;
  const slug = safeName((cfg.name || 'pack').toLowerCase()).replace(/^_+|_+$/g, '') || 'pack';
  const files = [];
  for (const [rel, f] of cfg.files) {
    if (!/\.(png|json|yml|txt)$/i.test(rel)) continue;
    const orig = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    // keep original capitalisation of the path below the textures root
    const keep = orig.slice(orig.length - rel.length);
    files.push({ path: `packs/${slug}/${keep}`, blob: f });
  }
  if (!files.length) { toast('No .png / meta.json files in this folder', true); return; }
  if (!confirmBox(`Upload ${files.length} files to ${S.config.repo}/packs/${slug}/ and add it to packs.json?`)) return;
  try {
    const cur = JSON.parse(await gh.readText('packs.json') || '{"packs":[]}');
    cur.packs = (cur.packs || []).filter(p => !(p.type === 'site' && p.path === 'packs/' + slug));
    cur.packs.unshift({ id: slug, name: cfg.name, type: 'site', path: 'packs/' + slug });
    const listed = files.map(f => f.path.slice(('packs/' + slug + '/').length));
    const rsis = [...new Set(listed.filter(f => /\.rsi\//i.test(f)).map(f => f.slice(0, f.toLowerCase().indexOf('.rsi/') + 4)))];
    files.push({ path: `packs/${slug}/index.json`, text: JSON.stringify({ name: cfg.name, rsis, files: listed.filter(f => !/\.rsi\//i.test(f)) }) + '\n' });
    files.push({ path: 'packs.json', text: JSON.stringify(cur, null, 2) + '\n' });
    progress(0, 'Uploading…');
    await gh.commit(files, `Add sprite pack ${slug}`, (d, t) => progress(d / t, `Uploading ${d} / ${t}`));
    progress(null);
    toast('Pack uploaded. GitHub Pages updates in a minute or two.');
    cfg.type = 'site'; cfg.path = 'packs/' + slug; delete cfg.files; cfg.id = slug;
    applyPacks(false);
  } catch (e) { progress(null); toast('Upload failed: ' + e.message, true); }
}
function confirmBox(msg) { try { return window.confirm(msg); } catch (e) { return true; } }

async function savePackOrder() {
  if (needToken()) return;
  const packs = S.packCfgs.filter(c => c.type !== 'local').map(({ files, ...c }) => c);
  try {
    await gh.commit([{ path: 'packs.json', text: JSON.stringify({ packs }, null, 2) + '\n' }], 'Update sprite pack order');
    toast('packs.json saved');
  } catch (e) { toast('Save failed: ' + e.message, true); }
}
async function saveMapToRepo() {
  if (needToken()) return;
  if (!S.mapSource) { toast('Open a map first', true); return; }
  const file = safeName(S.mapSource.name.replace(/\.ya?ml$/i, '')) + '.yml';
  try {
    let idx = { maps: [] };
    const cur = await gh.readText('maps/index.json');
    if (cur) idx = JSON.parse(cur);
    if (!idx.maps.includes(file)) idx.maps.push(file);
    idx.maps.sort();
    $('#repoStatus').textContent = 'Saving…';
    await gh.commit([
      { path: 'maps/' + file, text: S.mapSource.text },
      { path: 'maps/index.json', text: JSON.stringify(idx, null, 2) + '\n' },
    ], `Add map ${file}`);
    $('#repoStatus').textContent = `Saved as maps/${file}.`;
    toast('Map saved to the repo');
  } catch (e) { $('#repoStatus').textContent = ''; toast('Save failed: ' + e.message, true); }
}
async function saveDrawingsToRepo() {
  if (needToken()) return;
  if (!S.mapSource) { toast('Open a map first', true); return; }
  try {
    await gh.commit([{ path: 'annotations/' + safeName(mapKey()) + '.json', text: JSON.stringify({ map: mapKey(), ...annots.toJSON() }, null, 1) + '\n' }],
      `Drawings for ${S.mapSource.name}`);
    toast('Drawings saved to the repo');
  } catch (e) { toast('Save failed: ' + e.message, true); }
}

async function exportViewPng() {
  const c = document.createElement('canvas');
  c.width = mapCanvas.width; c.height = mapCanvas.height;
  const g = c.getContext('2d');
  g.drawImage(mapCanvas, 0, 0);
  g.drawImage(overlay, 0, 0);
  download(await canvasBlob(c), safeName((S.model && S.model.name) || 'map') + '.png');
}

// ---------------------------------------------------------------- UI wiring
function downloadYml() {
  if (!S.mapSource) { toast('Open a map first', true); return; }
  const name = /\.ya?ml$/i.test(S.mapSource.name) ? S.mapSource.name : (S.mapSource.name || 'map') + '.yml';
  download(new Blob([S.mapSource.text], { type: 'text/yaml' }), name);
}

function setupUI() {
  const savedOpts = LS.get('opts', null);
  if (savedOpts) for (const k of Object.keys(DEFAULT_OPTS)) if (typeof savedOpts[k] === 'boolean') S.renderer.opts[k] = savedOpts[k];
  $('#stage').dataset.tool = S.tool;
  $('#btnOpenFile').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('#btnBrowse').onclick = browseMaps;
  $('#btnDownloadYml').onclick = downloadYml;
  $('#modalClose').onclick = closeModal;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  $$('.tab[data-tab]').forEach(t => t.onclick = () => showTab(t.dataset.tab));
  $('#btnCollapse').onclick = () => togglePanel(false);
  $('#btnExpand').onclick = () => togglePanel(true);
  $$('.tool[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('#btnUndo').onclick = () => annots.undo();
  $('#btnRedo').onclick = () => annots.redo();

  const colors = ['#ffd23f', '#ff5c5c', '#4fc3d9', '#7bd88f', '#c792ea', '#ffffff', '#ff9f43', '#000000'];
  const sw = $('#swatches');
  const paintSw = () => $$('.sw').forEach(s => s.classList.toggle('active', s.dataset.c === S.color));
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.background = c; b.dataset.c = c; b.title = c;
    b.onclick = () => { S.color = c; LS.set('color', c); $('#colorPick').value = c; paintSw(); };
    sw.appendChild(b);
  }
  $('#colorPick').value = S.color;
  $('#colorPick').oninput = (e) => { S.color = e.target.value; LS.set('color', S.color); paintSw(); };
  paintSw();
  $('#sizeRange').value = S.size; $('#sizeVal').textContent = S.size;
  $('#sizeRange').oninput = (e) => { S.size = +e.target.value; $('#sizeVal').textContent = S.size; LS.set('size', S.size); drawOverlay(); };

  // packs
  $('#btnAddGh').onclick = () => {
    const repo = $('#ghRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Repo should look like owner/name', true); return; }
    S.packCfgs.unshift({ id: 'gh-' + Date.now().toString(36), name: repo.split('/')[1], type: 'github', repo,
      ref: $('#ghRef').value.trim() || 'master', path: $('#ghPath').value.trim(), enabled: true });
    applyPacks();
  };
  $('#btnAddSite').onclick = () => {
    const p = $('#sitePath').value.trim().replace(/^\/+|\/+$/g, '');
    if (!p) return;
    S.packCfgs.unshift({ id: 'site-' + Date.now().toString(36), name: baseName(p), type: 'site', path: p, enabled: true });
    applyPacks();
  };
  $('#localPick').onchange = (e) => {
    if (!e.target.files.length) return;
    const cfg = localPackFromFiles(e.target.files);
    S.packCfgs.unshift(cfg);
    e.target.value = '';
    toast(`Added ${cfg.name} (${cfg.files.size} files)`);
    applyPacks();
  };
  $('#btnPacksReset').onclick = () => { S.packCfgs = S.defaultPacks.map(p => ({ enabled: true, ...p })); applyPacks(); };
  $('#btnPacksSave').onclick = savePackOrder;

  renderToggles();
  $('#bgColor').value = S.bg;
  $('#bgColor').oninput = (e) => { S.bg = e.target.value; LS.set('bg', S.bg); draw(); };
  $('#protoFilter').oninput = renderProtoList;
  $('#btnCopyMissing').onclick = () => {
    const miss = [...(S.missing || new Map()).values()].sort((a, b) => b.count - a.count);
    copyText(miss.map(m => (m.protoUnknown ? 'proto ' + m.protoUnknown : m.tileUnknown ? 'tile ' + m.tileUnknown : m.tex ? m.tex : m.rsi + '/' + m.state + '.png') + '\t' + m.count).join('\n'));
  };
  $('#btnExportPng').onclick = exportViewPng;

  $('#btnDrawToggle').onclick = () => { annots.visible = !annots.visible; drawOverlay(); updateDrawStats(); };
  $('#btnDrawClear').onclick = () => { if (confirmBox('Remove all drawings on this map?')) annots.clear(); };
  $('#btnDrawExport').onclick = () => download(new Blob([JSON.stringify({ map: mapKey(), ...annots.toJSON() }, null, 1)], { type: 'application/json' }), safeName(mapKey()) + '.drawings.json');
  $('#drawImport').onchange = (e) => { const f = e.target.files[0]; if (f) importAnnots(f); e.target.value = ''; };
  $('#btnDrawRepo').onclick = saveDrawingsToRepo;

  $('#btnTokenSave').onclick = async () => {
    const v = $('#ghToken').value.trim();
    if (!v || v.startsWith('•')) return;
    gh.setToken(v);
    try { const u = await gh.whoami(); $('#tokenStatus').textContent = `Signed in as ${u.login}.`; toast('Token saved'); }
    catch (e) { $('#tokenStatus').textContent = 'Token did not work: ' + e.message; }
    $('#ghToken').value = '••••••••';
  };
  $('#btnTokenClear').onclick = () => { gh.setToken(''); renderRepoInfo(); };
  $('#btnSaveMap').onclick = saveMapToRepo;

  updateDrawStats();
  renderArea();
  setupInput();
  renderPacks();
}

boot();
