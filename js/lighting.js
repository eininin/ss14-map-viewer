// Optional realistic lighting for the map viewer: Starlight's own lighting, ported.
//  - js/clyde.js: the engine's light pass in WebGL2 (shadow maps from occluder edges, soft-shadow point lights
//    with masks, lighting FOV, light blur, wall bleed), Starlight's global illumination, light tonemap,
//    ambient occlusion and screen post-processing (night vision, bloom, vignette, film grain), at their
//    default settings
//  - js/robust-fov.js: the engine's occluder edges and the rules for which shared edges cast shadows
//  - light data: db/lights-<server>.json from tools/build_lights.py (a powered station in daytime)
//  - game view: the station as seen from the cursor with the game's FOV; elsewhere the eye is the view centre
//
// Self-contained add-on. To remove it: delete this file, js/clyde.js, js/robust-fov.js, db/lights-*.json,
// tools/build_lights.py, and the lines marked "lighting add-on" in js/app.js and .github/workflows/update-db.yml.
// The Station Guesser and the previews are not affected.
import { buildOccluderGeometry, computeFov, fovPolygon, depthEdges, embeddedInOccluder } from './robust-fov.js?v=2';
import { ClydeLighting, invert3 } from './clyde.js?v=1';
import { NET_CATS } from './scene.js?v=75';

const LS = 'ss14mv.lighting';
const DEF = { on: false, ambient: 0, hiddenLights: false, ao: true, gi: true, bloom: true, vignette: true, grain: true, nightVision: true, gameView: false };
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch (e) { return { ...DEF }; } })();
const saveSt = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) { /* ignore */ } };

let env = null;
const data = new Map();            // fork -> Promise(ents)
let ents = null, entsFork = null;
let glCv = null, fovCv = null, clyde = null, glError = null;
let cursor = null, fovRaf = 0, grainRaf = 0;
const geomCache = new WeakMap();   // grid -> { scene, geom }
const splitCache = new WeakMap();  // chunk canvas -> { tile, ent, glow }
const maskImgs = new Map();        // texture path -> img | null (loading)
let scratch = null;

// ---------------------------------------------------------------- setup
export function initLighting(e) {
  env = e;
  const pane = document.getElementById('paneLayers');
  if (pane) {
    const box = document.createElement('div');
    box.innerHTML = `
      <h3>Lighting</h3>
      <label class="row tglbtn" title="Starlight's lighting: lights, shadows, global illumination and post-processing as the game draws them (a powered station)">
        <input type="checkbox" data-k="on"> Realistic lighting</label>
      <div class="lgtopts">
        <label class="row tglbtn" title="Ambient occlusion: a dark rim along walls"><input type="checkbox" data-k="ao"> Ambient occlusion</label>
        <label class="row tglbtn" title="Light from lit walls bouncing onto the floor"><input type="checkbox" data-k="gi"> Global illumination</label>
        <label class="row tglbtn" title="Poorly lit areas lose their colour and turn blue"><input type="checkbox" data-k="nightVision"> Night vision</label>
        <label class="row tglbtn"><input type="checkbox" data-k="bloom"> Bloom</label>
        <label class="row tglbtn"><input type="checkbox" data-k="vignette"> Vignette</label>
        <label class="row tglbtn"><input type="checkbox" data-k="grain"> Film grain</label>
        <label class="row tglbtn" title="Lights whose objects are hidden by the layers above still shine"><input type="checkbox" data-k="hiddenLights"> Lights from hidden objects</label>
        <label class="row" title="The map's ambient light; the game's stations have none (0)">Ambient <input type="range" id="lgtAmb" min="0" max="0.3" step="0.01" value="${st.ambient}" style="flex:1"></label>
      </div>
      <label class="row tglbtn" title="See the station as from where the cursor is, with the game's own field of view"><input type="checkbox" data-k="gameView"> Game view at the cursor</label>
      <p class="hint" id="lgtNote"></p>`;
    pane.appendChild(box);
    box.querySelectorAll('input[data-k]').forEach(inp => {
      inp.checked = !!st[inp.dataset.k];
      inp.onchange = () => {
        st[inp.dataset.k] = inp.checked; saveSt();
        box.querySelector('.lgtopts').hidden = !st.on;
        if (clyde) clyde.resetHistory();
        if (!st.on) note('');
        env.redraw();
      };
    });
    box.querySelector('.lgtopts').hidden = !st.on;
    box.querySelector('#lgtAmb').oninput = (ev) => { st.ambient = +ev.target.value; saveSt(); env.redraw(); };
  }
  const stage = document.getElementById('stage'), over = document.getElementById('overlayCanvas');
  glCv = document.createElement('canvas');
  glCv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none;';
  stage.insertBefore(glCv, over);
  fovCv = document.createElement('canvas');
  fovCv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
  stage.insertBefore(fovCv, over);
  over.addEventListener('pointermove', (ev) => { cursor = [ev.offsetX, ev.offsetY]; if (st.gameView) queueRedraw(); });
  over.addEventListener('pointerleave', () => { cursor = null; if (st.gameView) queueRedraw(); });
}

function note(t) { const n = document.getElementById('lgtNote'); if (n) n.textContent = t; }
function queueRedraw() {
  if (fovRaf) return;
  fovRaf = requestAnimationFrame(() => { fovRaf = 0; env.redraw(); });
}

function loadData(fork) {
  if (!data.has(fork)) {
    data.set(fork, fetch(`db/lights-${fork}.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { ent: {} }).then(j => {
        const out = j.ent || {};
        for (const v of Object.values(out)) {        // older files: pl as a list
          if (Array.isArray(v.pl)) { const p = v.pl; v.pl = { r: p[0], e: p[1], s: p[2], f: p[3], c: p[4], col: p[5], o: [p[6], p[7]], sh: p[8] }; }
        }
        return out;
      }).catch(() => ({})));
  }
  return data.get(fork);
}

const lightOn = (R, it) => st.hiddenLights || R.visible(it);
const toLin = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

function maskFor(path) {
  if (!path) return null;
  if (maskImgs.has(path)) return maskImgs.get(path);
  maskImgs.set(path, null);
  const store = env.getStore && env.getStore();
  if (store) store.texture(path).then(r => { if (r && r.img && !r.dev) { maskImgs.set(path, r.img); env.redraw(); } }).catch(() => {});
  return null;
}

function geometry(scene, gr) {
  let gc = geomCache.get(gr);
  if (!gc || gc.scene !== scene) { gc = { scene, geom: buildOccluderGeometry(scene.items, gr.uid) }; geomCache.set(gr, gc); }
  return gc.geom;
}

// tiles and decals / other entities / unshaded layers of a chunk, as the engine draws them apart
function patchRenderer(R) {
  const proto = Object.getPrototypeOf(R);
  if (proto.__lightingPatched) return;
  const orig = proto.renderChunk;
  proto.renderChunk = function (gr, c) { if (c.canvas) splitCache.delete(c.canvas); return orig.call(this, gr, c); };
  proto.__lightingPatched = true;
}
function splitChunk(R, gr, c, CHUNK, PX) {
  let s = splitCache.get(c.canvas);
  if (s) return s;
  const mk = () => { const cv = document.createElement('canvas'); cv.width = cv.height = CHUNK * PX; const g = cv.getContext('2d'); g.imageSmoothingEnabled = false; return [cv, g]; };
  const [tile, tg] = mk(), [ent, eg] = mk();
  let glow = null, gg = null;
  const x0 = c.cx * CHUNK, y1 = (c.cy + 1) * CHUNK;
  const toPx = (x, y) => [(x - x0) * PX, (y1 - y) * PX];
  if (R.opts.tiles) for (const t of c.tiles) if (R.tileVisible(gr.uid, t)) R.drawTile(tg, t, x0, y1, PX);
  const order = R.opts.pipeMode === 'top'
    ? [...c.items.filter(it => !isNet(it)), ...c.items.filter(isNet)] : c.items;
  for (const it of order) {
    if (!R.visible(it)) continue;
    if (it.kind === 'decal') { R.drawItem(tg, it, toPx, PX); continue; }   // decals are part of the grid pass
    R.drawItem(eg, it, toPx, PX);
    const L = ents && it.kind === 'ent' ? ents[it.proto] : null;
    if (!L || !(L.un || L.ua)) continue;
    const maps = (l) => Array.isArray(l.map) ? l.map : l.map ? [l.map] : [];
    const layers = L.ua ? it.layers : it.layers.filter(l =>
      (l.state != null && L.un.s.includes(String(l.state))) || maps(l).some(m => L.un.m.includes(m)));
    if (!layers.length) continue;
    if (!glow) [glow, gg] = mk();
    R.drawItem(gg, { ...it, layers }, toPx, PX);
  }
  s = { tile, ent, glow };
  splitCache.set(c.canvas, s);
  return s;
}
const isNet = (it) => NET_CATS.has(it.cat);

// ---------------------------------------------------------------- drawing (called by app.js after the map)
export function drawLighting(g, setGridXf, frame, overview) {
  if (!env || !glCv) return;
  const scene = env.getScene(), R = env.getRenderer(), map = g.canvas;
  const lit = !!(st.on && scene && R.grids);
  for (const c of [glCv, fovCv]) if (c.width !== map.width || c.height !== map.height) { c.width = map.width; c.height = map.height; }
  glCv.style.height = fovCv.style.height = map.style.height || '100%';
  const fg = fovCv.getContext('2d');
  fg.setTransform(1, 0, 0, 1, 0, 0);
  fg.clearRect(0, 0, fovCv.width, fovCv.height);
  if (!lit) {
    glCv.style.display = 'none';
    stopGrain();
    if (st.gameView && scene && R.grids) drawFovOnly(fg, setGridXf);
    return;
  }
  if (entsFork !== env.getFork()) {
    entsFork = env.getFork(); ents = null;
    loadData(entsFork).then(e => { if (entsFork === env.getFork()) { ents = e; env.redraw(); } });
  }
  if (!ents) { note('Lighting: loading…'); return; }
  if (!Object.keys(ents).length) { note('No light data for this server yet.'); glCv.style.display = 'none'; return; }
  if (!clyde && !glError) {
    try { clyde = new ClydeLighting(glCv); } catch (err) { glError = err; console.error(err); }
  }
  if (!clyde) { note('Lighting needs WebGL2 with float render targets: ' + glError.message); glCv.style.display = 'none'; return; }
  patchRenderer(R);
  try {
    renderFrame(map, setGridXf, frame, overview, scene, R);
    glCv.style.display = '';
    note('');
  } catch (err) {
    console.error(err);
    note('Lighting failed: ' + err.message);
    glCv.style.display = 'none';
  }
  if (st.grain) startGrain(); else stopGrain();
}

function startGrain() {
  if (grainRaf) return;
  let last = 0;
  const tick = (t) => {
    grainRaf = requestAnimationFrame(tick);
    if (t - last < 1000 / 24 || !clyde || glCv.style.display === 'none') return;
    last = t; clyde.post(t / 1000);
  };
  grainRaf = requestAnimationFrame(tick);
}
function stopGrain() { if (grainRaf) cancelAnimationFrame(grainRaf); grainRaf = 0; }

function gridMatrix(setGridXf, gr) {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d');
  setGridXf(scratch, gr);
  const m = scratch.getTransform();
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

function renderFrame(map, setGridXf, frame, overview, scene, R) {
  const { PX, CHUNK } = env;
  const w = map.width, h = map.height;
  const grids = [...R.grids.values()].filter(gr => isFinite(gr.minX));
  if (!grids.length) return;
  const M0 = gridMatrix(setGridXf, grids[0]);
  const k = Math.hypot(M0[0], M0[1]);                         // device pixels per tile
  // world space of the view: x right, y up, in tiles; screen pixel (sx, sy) <-> (sx / k, -sy / k)
  const worldToClip = [2 * k / w, 0, 0, 0, 2 * k / h, 0, -1, 1, 1];
  const clipToWorld = invert3(worldToClip);
  const sx0 = 0, sx1 = w / k, sy0 = -h / k, sy1 = 0;           // the view's box

  // the layers the world is drawn from
  const mkLayer = (name) => {
    let cv = renderFrame[name];
    if (!cv) cv = renderFrame[name] = document.createElement('canvas');
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const lg = cv.getContext('2d');
    lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, w, h);
    lg.imageSmoothingEnabled = false;
    return [cv, lg];
  };
  const [tileCv, tg] = mkLayer('_tile'), [entCv, eg] = mkLayer('_ent'), [glowCv, gg] = mkLayer('_glow');
  let haveLayers = !overview;
  const parts = [];
  for (const gr of grids) {
    const M = gridMatrix(setGridXf, gr);
    const f = (x, y) => [(M[0] * x + M[2] * y + M[4]) / k, -(M[1] * x + M[3] * y + M[5]) / k];
    const inv = invert3([M[0], M[1], 0, M[2], M[3], 0, M[4], M[5], 1]);
    const fi = (X, Y) => { const sx = X * k, sy = -Y * k; return [inv[0] * sx + inv[3] * sy + inv[6], inv[1] * sx + inv[4] * sy + inv[7]]; };
    parts.push({ gr, M, f, fi, geom: geometry(scene, gr) });
    if (overview && gr.ov) {
      setGridXf(tg, gr);
      tg.save(); tg.imageSmoothingEnabled = k < gr.ov.op; tg.translate(gr.ov.x0, gr.ov.y1); tg.scale(1 / gr.ov.op, -1 / gr.ov.op); tg.drawImage(gr.ov.canvas, 0, 0); tg.restore();
      continue;
    }
    for (const c of gr.chunks.values()) {
      if (!c.canvas && gr.ov && gr.ov.done.has(c)) {         // not drawn sharp yet: the overview's part stands in
        const ov = gr.ov, sxo = (c.cx * CHUNK - ov.x0) * ov.op, syo = (ov.y1 - (c.cy + 1) * CHUNK) * ov.op, sz = CHUNK * ov.op;
        setGridXf(tg, gr);
        tg.save(); tg.imageSmoothingEnabled = true; tg.translate(c.cx * CHUNK, (c.cy + 1) * CHUNK); tg.scale(CHUNK / sz, -CHUNK / sz);
        tg.drawImage(ov.canvas, sxo, syo, sz, sz, 0, 0, sz, sz); tg.restore();
        continue;
      }
      if (!c.canvas || c.used < frame) continue;
      const s = splitChunk(R, gr, c, CHUNK, PX);
      for (const [lg, cv] of [[tg, s.tile], [eg, s.ent], [gg, s.glow]]) {
        if (!cv) continue;
        setGridXf(lg, gr);
        lg.save(); lg.translate(c.cx * CHUNK, (c.cy + 1) * CHUNK); lg.scale(1 / PX, -1 / PX); lg.drawImage(cv, 0, 0); lg.restore();
      }
    }
  }

  // the eye: the cursor in game view, else the centre of the view
  const dpr = w / (map.clientWidth || w);
  const gameEye = st.gameView && cursor;
  const eye = gameEye ? [cursor[0] * dpr / k, -cursor[1] * dpr / k] : [w / 2 / k, -h / 2 / k];

  // lights touching the view
  const lights = [];
  let ex0 = sx0, ex1 = sx1, ey0 = sy0, ey1 = sy1;
  const byGrid = new Map(parts.map(p => [p.gr.uid, p]));
  for (const it of scene.items) {
    if (it.kind !== 'ent') continue;
    const L = ents[it.proto];
    if (!L || !L.pl) continue;
    const p = byGrid.get(it.grid);
    if (!p || !lightOn(R, it)) continue;
    const pl = L.pl;
    const rot = (it.rot || 0) - ((it.info && it.info.r) || 0);
    const c = Math.cos(rot), s = Math.sin(rot);
    const lx = it.x + pl.o[0] * c - pl.o[1] * s, ly = it.y + pl.o[0] * s + pl.o[1] * c;   // offset turns with the entity
    const pos = p.f(lx, ly);
    const R2 = pl.r;
    if (pos[0] + R2 < sx0 || pos[0] - R2 > sx1 || pos[1] + R2 < sy0 || pos[1] - R2 > sy1) continue;
    if (pl.sh && embeddedInOccluder(p.geom, lx, ly)) continue;   // shadow-casting lights inside a wall are dropped
    let mask = null, maskRot = 0;
    if (pl.m) {
      const img = maskFor(pl.m);
      if (!img) continue;
      mask = clyde.maskTexture(pl.m, img);
      // mask rotation: the light's own (0) plus the entity's world rotation when autoRot
      const ax = p.f(1, 0), o = p.f(0, 0);
      const gridRot = Math.atan2(ax[1] - o[1], ax[0] - o[0]);
      maskRot = pl.ar ? rot + gridRot : gridRot - (p.gr.xf ? p.gr.xf.r : 0);   // world angle 0 in this view
    }
    const col = pl.col || '#ffffff';
    lights.push({
      pos, radius: pl.r, energy: pl.e, softness: pl.s, falloff: pl.f, curve: pl.c, shadows: !!pl.sh, mask, maskRot,
      color: [toLin(parseInt(col.slice(1, 3), 16) / 255), toLin(parseInt(col.slice(3, 5), 16) / 255), toLin(parseInt(col.slice(5, 7), 16) / 255)],
    });
    ex0 = Math.min(ex0, pos[0]); ex1 = Math.max(ex1, pos[0]); ey0 = Math.min(ey0, pos[1]); ey1 = Math.max(ey1, pos[1]);
  }
  let row = 0;
  for (const l of lights) l.shadowRow = l.shadows ? row++ : -1;

  // occluder edges for this eye, occluder polygons (wall merge, GI seeds) and the AO source
  const edges = [], occluderPolys = [], aoPolys = [];
  const exp = 4 / 32;
  for (const p of parts) {
    const box = [p.fi(ex0, ey0), p.fi(ex1, ey0), p.fi(ex0, ey1), p.fi(ex1, ey1)];
    const bx0 = Math.min(...box.map(b => b[0])), bx1 = Math.max(...box.map(b => b[0]));
    const by0 = Math.min(...box.map(b => b[1])), by1 = Math.max(...box.map(b => b[1]));
    const eL = p.fi(eye[0], eye[1]);
    for (const e of depthEdges(p.geom, eL[0], eL[1], bx0, by0, bx1, by1)) {
      const a = p.f(e[0], e[1]), b = p.f(e[2], e[3]);
      edges.push([a[0], a[1], b[0], b[1]]);
    }
    const vb = [p.fi(sx0, sy0), p.fi(sx1, sy0), p.fi(sx0, sy1), p.fi(sx1, sy1)];
    const vx0 = Math.min(...vb.map(b => b[0])) - 1, vx1 = Math.max(...vb.map(b => b[0])) + 1;
    const vy0 = Math.min(...vb.map(b => b[1])) - 1, vy1 = Math.max(...vb.map(b => b[1])) + 1;
    for (const o of p.geom.occ) {
      if (o.x1 < bx0 || o.x0 > bx1 || o.y1 < by0 || o.y0 > by1) continue;
      occluderPolys.push(o.verts.map(([x, y]) => p.f(x, y)));
      if (o.x1 < vx0 || o.x0 > vx1 || o.y1 < vy0 || o.y0 > vy1) continue;
      let cx = 0, cy = 0;
      for (const [x, y] of o.verts) { cx += x; cy += y; }
      cx /= o.verts.length; cy /= o.verts.length;
      aoPolys.push(o.verts.map(([x, y]) => {
        const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy);
        return p.f(l > 0 ? x + dx / l * exp : x, l > 0 ? y + dy / l * exp : y);
      }));
    }
  }

  const amb = toLin(st.ambient);
  clyde.render({
    w, h, k, worldToClip, clipToWorld, eye, drawFov: !!gameEye, edges, lights, occluderPolys, aoPolys,
    layers: { map, tile: tileCv, ent: entCv, glow: glowCv }, haveLayers,
    opts: { ao: st.ao, gi: st.gi, bloom: st.bloom, vignette: st.vignette, grain: st.grain, nightVision: st.nightVision },
    ambient: [st.ambient ? amb : 0, st.ambient ? amb : 0, st.ambient ? amb : 0],
  });
}

// ---------------------------------------------------------------- game view without the lighting
function drawFovOnly(g, setGridXf) {
  const scene = env.getScene(), R = env.getRenderer();
  if (!cursor) return;
  const [wx, wy] = env.toWorld(cursor[0], cursor[1]);
  let gr = null;
  for (const c of R.grids.values()) {
    const [lx, ly] = env.gridLocal(c, wx, wy);
    if (lx >= c.minX - 1 && lx <= c.maxX + 1 && ly >= c.minY - 1 && ly <= c.maxY + 1) { gr = c; break; }
  }
  if (!gr) return;
  const [lx, ly] = env.gridLocal(gr, wx, wy);
  const range = Math.min(60, Math.hypot(fovCv.width, fovCv.height) / (2 * (window.devicePixelRatio || 1) * env.camScale()) + 2);
  const p = fovPolygon(computeFov(geometry(scene, gr), lx, ly, range), range);
  const vis = new Path2D();
  vis.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) vis.lineTo(p[i], p[i + 1]);
  vis.closePath();
  g.fillStyle = '#000';
  g.fillRect(0, 0, fovCv.width, fovCv.height);
  g.save();
  setGridXf(g, gr);
  g.globalCompositeOperation = 'destination-out';
  g.fill(vis);
  g.restore();
}
