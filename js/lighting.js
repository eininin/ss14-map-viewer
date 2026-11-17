// Optional "realistic lighting" for the map viewer, as in the game: everything starts dark, every
// light adds its glow (the engine's own falloff), walls and closed doors cast shadows, and parts of
// sprites marked "unshaded" (screens, lamps, lit vending machines) still glow on top.
//
// Self-contained add-on. To remove it: delete this file, db/lights-*.json, tools/build_lights.py,
// and the lines marked "lighting add-on" in js/app.js and .github/workflows/update-db.yml.
// Nothing else depends on it; the Station Guesser and the previews are not affected.

const LS = 'ss14mv.lighting';
const st = (() => { try { return { on: false, ambient: 0.03, gain: 1.6, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch (e) { return { on: false, ambient: 0.03, gain: 1.6 }; } })();
const saveSt = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) { /* ignore */ } };

const K = (x, y) => (x + 32768) * 65536 + (y + 32768);
let env = null;                 // { getScene, getRenderer, getFork, redraw, PX, CHUNK }
const data = new Map();         // fork id -> Promise<ent map>
let job = null;                 // the lightmaps being built for the current map
const unshadedCache = new WeakMap();   // chunk canvas -> canvas with only the glowing layers

// ---------------------------------------------------------------- setup
export function initLighting(e) {
  env = e;
  const pane = document.getElementById('paneLayers');
  if (!pane) return;
  const box = document.createElement('div');
  box.innerHTML = `
    <h3>Lighting</h3>
    <label class="row tglbtn" title="Lights, shadows and glowing screens as in the game (assumes a powered station)">
      <input type="checkbox" id="lgtOn" ${st.on ? 'checked' : ''}> Realistic lighting</label>
    <label class="row">Brightness <input type="range" id="lgtGain" min="0.5" max="4" step="0.1" value="${st.gain}" style="flex:1"></label>
    <label class="row">Unlit areas <input type="range" id="lgtAmb" min="0" max="0.5" step="0.01" value="${st.ambient}" style="flex:1"></label>
    <p class="hint" id="lgtNote">Off. Unlit places are black in the game; raise “Unlit areas” to see into them.</p>`;
  pane.appendChild(box);
  box.querySelector('#lgtOn').onchange = (ev) => { st.on = ev.target.checked; saveSt(); job = null; env.redraw(); };
  box.querySelector('#lgtGain').onchange = (ev) => { st.gain = +ev.target.value; saveSt(); job = null; env.redraw(); };
  box.querySelector('#lgtAmb').onchange = (ev) => { st.ambient = +ev.target.value; saveSt(); job = null; env.redraw(); };
}

function note(t) { const n = document.getElementById('lgtNote'); if (n) n.textContent = t; }

function loadData(fork) {
  if (!data.has(fork)) {
    data.set(fork, fetch(`db/lights-${fork}.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { ent: {} }).then(j => j.ent || {}).catch(() => ({})));
  }
  return data.get(fork);
}

// ---------------------------------------------------------------- building the light maps
function startJob() {
  const scene = env.getScene(), R = env.getRenderer(), fork = env.getFork();
  const myJob = { scene, fork, amb: st.ambient, gain: st.gain, grids: new Map(), ready: false, lights: null };
  job = myJob;
  note('Lighting: preparing…');
  loadData(fork).then(async (ents) => {
    if (job !== myJob) return;
    myJob.lights = ents;
    if (!Object.keys(ents).length) { note('No light data for this server yet.'); return; }
    let total = 0, done = 0;
    const work = [];
    for (const gr of R.grids.values()) {
      if (!isFinite(gr.minX)) continue;
      const opaque = new Set();
      const sources = [];
      for (const it of scene.items) {
        if (it.kind !== 'ent' || it.grid !== gr.uid) continue;
        if (it.info && it.info.oc && !(it.info.door != null && it.door === 'open')) opaque.add(K(it.tx, it.ty));
        const L = ents[it.proto];
        if (L && L.pl) sources.push([it, L.pl]);
      }
      total += sources.length;
      work.push({ gr, opaque, sources });
    }
    for (const w of work) {
      const lm = buildGrid(w.gr, scene, w.opaque, myJob.amb);
      myJob.grids.set(w.gr.uid, lm);
      const targets = corners(w.opaque);
      for (let i = 0; i < w.sources.length; i++) {
        if (job !== myJob) return;
        addLight(lm, w.opaque, targets, w.sources[i][0], w.sources[i][1], myJob.gain);
        done++;
        if (i % 60 === 59) { note(`Lighting: ${done} / ${total} lights…`); await new Promise(r => setTimeout(r, 0)); }
      }
      finishGrid(lm, w.opaque);
    }
    if (job !== myJob) return;
    myJob.ready = true;
    note(`Lighting: ${total} lights. Powered station assumed.`);
    env.redraw();
  });
}

function buildGrid(gr, scene, opaque, amb) {
  const area = (gr.maxX - gr.minX) * (gr.maxY - gr.minY);
  const P = area > 160000 ? 4 : area > 40000 ? 6 : 8;           // light-map pixels per tile
  const x0 = Math.floor(gr.minX) - 2, y1 = Math.ceil(gr.maxY) + 2;
  const w = Math.ceil(gr.maxX) + 2 - x0, h = y1 - (Math.floor(gr.minY) - 2);
  const c = document.createElement('canvas');
  c.width = w * P; c.height = h * P;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';                       // space and open lattice keep their colours
  g.fillRect(0, 0, c.width, c.height);
  const a = Math.round(amb * 255);
  g.fillStyle = `rgb(${a},${a},${a})`;        // the station itself starts dark
  for (const t of (scene.tiles.get(gr.uid) || [])) {
    if (/lattice/i.test(t.name || '')) continue;
    g.fillRect((t.x - x0) * P, (y1 - t.y - 1) * P, P, P);
  }
  for (const k of opaque) g.fillRect((Math.floor(k / 65536) - 32768 - x0) * P, (y1 - (k % 65536 - 32768) - 1) * P, P, P);
  return { canvas: c, g, P, x0, y1, w, h };
}

// outer corners of the sight-blocking tiles (where shadow edges start)
function corners(opaque) {
  const out = [], seen = new Set();
  const has = (x, y) => opaque.has(K(x, y)) ? 1 : 0;
  for (const k of opaque) {
    const x = Math.floor(k / 65536) - 32768, y = k % 65536 - 32768;
    for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      const ck = K(cx, cy);
      if (seen.has(ck)) continue;
      seen.add(ck);
      const n = has(cx - 1, cy - 1) + has(cx, cy - 1) + has(cx - 1, cy) + has(cx, cy);
      if (n === 1 || n === 3 || (n === 2 && has(cx - 1, cy - 1) === has(cx, cy))) out.push([cx, cy]);
    }
  }
  return out;
}

function castRay(opaque, px, py, dx, dy, maxT) {
  let x = Math.floor(px), y = Math.floor(py);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? 1 / Math.abs(dx) : Infinity, tdy = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? x + 1 - px : px - x) * tdx : Infinity;
  let ty = dy !== 0 ? (dy > 0 ? y + 1 - py : py - y) * tdy : Infinity;
  for (;;) {
    let t;
    if (tx < ty) { t = tx; tx += tdx; x += sx; } else { t = ty; ty += tdy; y += sy; }
    if (t >= maxT) return maxT;
    if (opaque.has(K(x, y))) return t;
  }
}

// the engine's point light falloff (Robust light_shared.swsl), with a light height of 1 tile
function falloff(d, R, falloffK, curve) {
  const s = Math.min(1, Math.max(0, Math.sqrt(d * d + 1) / R)), s2 = s * s;
  const cf = s + (s2 - s) * Math.min(1, Math.max(0, curve));
  return Math.min(1, Math.max(0, ((1 - s2) * (1 - s2)) / (1 + falloffK * cf)));
}

function addLight(lm, opaque, targets, it, pl, gain) {
  const [R, energy, , fk, curve, col, ox, oy, shadows] = pl;
  const c = Math.cos(it.rot || 0), s = Math.sin(it.rot || 0);
  let px = it.x + ox * c - oy * s, py = it.y + ox * s + oy * c;
  if (opaque.has(K(Math.floor(px), Math.floor(py)))) { px = it.x; py = it.y; }   // keep the light out of the wall
  const { g, P, x0, y1 } = lm;
  const toX = (x) => (x - x0) * P, toY = (y) => (y1 - y) * P;
  // the lit area: rays to every wall corner in reach, so shadow edges are straight
  const path = new Path2D();
  if (shadows) {
    const angles = [];
    for (const [tx, ty] of targets) {
      const ddx = tx - px, ddy = ty - py;
      if (ddx * ddx + ddy * ddy > R * R) continue;
      const a = Math.atan2(ddy, ddx);
      angles.push(a - 1e-4, a + 1e-4);
    }
    for (let i = 0; i < 96; i++) angles.push(-Math.PI + i * Math.PI / 48);
    angles.sort((a, b) => a - b);
    let first = true;
    for (const a of angles) {
      const dx = Math.cos(a), dy = Math.sin(a), t = castRay(opaque, px, py, dx, dy, R);
      const X = toX(px + dx * t), Y = toY(py + dy * t);
      if (first) { path.moveTo(X, Y); first = false; } else path.lineTo(X, Y);
    }
    path.closePath();
  } else path.arc(toX(px), toY(py), R * P, 0, Math.PI * 2);
  const r = parseInt(col.slice(1, 3), 16), gg = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
  const grad = g.createRadialGradient(toX(px), toY(py), 0, toX(px), toY(py), R * P);
  for (let i = 0; i <= 16; i++) {
    const v = Math.min(1, falloff(R * i / 16, R, fk, curve) * energy * gain);
    grad.addColorStop(i / 16, `rgb(${Math.round(r * v)},${Math.round(gg * v)},${Math.round(b * v)})`);
  }
  g.save();
  g.globalCompositeOperation = 'lighter';     // lights add up, as in the game
  g.fillStyle = grad;
  g.fill(path);
  g.restore();
}

// walls take the light of the floor in front of them; then a light blur, as the game does
function finishGrid(lm, opaque) {
  const { canvas, g, P, x0, y1, w, h } = lm;
  const img = g.getImageData(0, 0, canvas.width, canvas.height), d = img.data, W = canvas.width;
  const px = (x, y) => (((y1 - y - 1) * P + (P >> 1)) * W + (x - x0) * P + (P >> 1)) * 4;
  for (const k of opaque) {
    const x = Math.floor(k / 65536) - 32768, y = k % 65536 - 32768;
    let rr = 0, gg = 0, bb = 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (opaque.has(K(nx, ny)) || nx < x0 || nx >= x0 + w || ny >= y1 || ny < y1 - h) continue;
      const i = px(nx, ny);
      rr = Math.max(rr, d[i]); gg = Math.max(gg, d[i + 1]); bb = Math.max(bb, d[i + 2]);
    }
    const sx = (x - x0) * P, sy = (y1 - y - 1) * P;
    for (let yy = 0; yy < P; yy++) for (let xx = 0; xx < P; xx++) {
      const i = ((sy + yy) * W + sx + xx) * 4;
      d[i] = Math.max(d[i], rr); d[i + 1] = Math.max(d[i + 1], gg); d[i + 2] = Math.max(d[i + 2], bb);
    }
  }
  g.putImageData(img, 0, 0);
  const soft = document.createElement('canvas');
  soft.width = canvas.width; soft.height = canvas.height;
  const sg = soft.getContext('2d');
  sg.filter = `blur(${Math.max(1, P * 0.3)}px)`;
  sg.drawImage(canvas, 0, 0);
  lm.canvas = soft; lm.g = null;
}

// ---------------------------------------------------------------- drawing (called by app.js after the map)
// g: the map canvas context; setGridXf(g, gr) puts it in grid coordinates; frame: when this frame began
export function drawLighting(g, setGridXf, frame, overview) {
  if (!st.on || !env) return;
  const scene = env.getScene(), R = env.getRenderer();
  if (!scene || !R.grids) return;
  if (!job || job.scene !== scene || job.fork !== env.getFork() || job.amb !== st.ambient || job.gain !== st.gain) startJob();
  if (!job.ready) return;
  const { PX, CHUNK } = env;
  for (const gr of R.grids.values()) {
    const lm = job.grids.get(gr.uid);
    if (!lm) continue;
    setGridXf(g, gr);
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.imageSmoothingEnabled = true;
    g.translate(lm.x0, lm.y1);
    g.scale(1 / lm.P, -1 / lm.P);
    g.drawImage(lm.canvas, 0, 0);
    g.restore();
    if (overview) continue;                   // zoomed far out: glowing bits are too small to matter
    for (const c of gr.chunks.values()) {
      if (!c.canvas || c.used < frame) continue;
      let u = unshadedCache.get(c.canvas);
      if (u === undefined) { u = glowChunk(R, c, CHUNK, PX); unshadedCache.set(c.canvas, u); }
      if (!u) continue;
      g.save();
      g.imageSmoothingEnabled = false;
      g.translate(c.cx * CHUNK, (c.cy + 1) * CHUNK);
      g.scale(1 / PX, -1 / PX);
      g.drawImage(u, 0, 0);
      g.restore();
    }
  }
}

// the parts of sprites that glow in the dark ("unshaded" layers), for one chunk
function glowChunk(R, c, CHUNK, PX) {
  const ents = job && job.lights;
  if (!ents) return null;
  let cv = null, g = null;
  const x0 = c.cx * CHUNK, y1 = (c.cy + 1) * CHUNK;
  const toPx = (x, y) => [(x - x0) * PX, (y1 - y) * PX];
  for (const it of c.items) {
    if (it.kind !== 'ent') continue;
    const L = ents[it.proto];
    if (!L || !(L.un || L.ua) || !R.visible(it)) continue;
    const maps = (l) => Array.isArray(l.map) ? l.map : l.map ? [l.map] : [];
    const layers = L.ua ? it.layers : it.layers.filter(l =>
      (l.state != null && L.un.s.includes(String(l.state))) || maps(l).some(m => L.un.m.includes(m)));
    if (!layers.length) continue;
    if (!cv) { cv = document.createElement('canvas'); cv.width = cv.height = CHUNK * PX; g = cv.getContext('2d'); g.imageSmoothingEnabled = false; }
    R.drawItem(g, { ...it, layers }, toPx, PX);
  }
  return cv;
}
