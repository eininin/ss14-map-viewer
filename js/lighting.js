// Optional realistic lighting for the map viewer, done the way Starlight's client does it:
//  - every light adds the engine's point-light falloff (Robust light_shared.swsl) in linear colour,
//    cut by walls and closed doors; the light map is tonemapped (Starlight LightTonemapOverlay:
//    knee 0.7, max 1.15) and blurred, then multiplies the world (sRGB output, so gamma-encoded here)
//  - walls take the light that bleeds onto them
//  - ambient occlusion: a soft dark rim on floors along walls (Starlight #04080F, alpha 0xAA, 4 px)
//  - "unshaded" sprite layers (lamps, screens, lit fronts) glow on top
//  - post-processing as Starlight's ScreenPostProcessOverlay: bloom (strength 1.5, threshold 0.15),
//    vignette (0.5) and film grain (0.05)
//  - game view: the station as seen from the cursor with the engine's own FOV (robust-fov.js) and, with
//    lighting on, the engine's lighting FOV and wall bleed for that eye
//
// Self-contained add-on. To remove it: delete this file, db/lights-*.json, tools/build_lights.py,
// and the lines marked "lighting add-on" in js/app.js and .github/workflows/update-db.yml.
// The Station Guesser and the previews are not affected.
import { tileX, tileY } from './fov.js?v=78';
import { buildOccluderGeometry, computeFov, fovPolygon, lightingOcclusion } from './robust-fov.js?v=1';

const LS = 'ss14mv.lighting';
const DEF = { on: false, ambient: 0, hiddenLights: false, ao: true, bloom: true, vignette: true, grain: true, gameView: false };
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch (e) { return { ...DEF }; } })();
const saveSt = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) { /* ignore */ } };

// Starlight settings
const TONE_KNEE = 0.7, TONE_MAX = 1.15, LIT_ALBEDO = 0.8;
const BLOOM_STRENGTH = 1.5, BLOOM_THRESHOLD = 0.15, VIGNETTE = 0.5, GRAIN = 0.05;
const AO_COLOR = [4, 8, 15], AO_ALPHA = 0xAA / 255, AO_DIST = 4 / 32;

const K = (x, y) => (x + 32768) * 65536 + (y + 32768);
let env = null;
const data = new Map();
let job = null;
const unshadedCache = new WeakMap();
let cvFov = null, cvBloom = null, cvFx = null, grainEl = null;
let cursor = null, fovRaf = 0, lastFovMask = null, relightTimer = 0;

// ---------------------------------------------------------------- setup
export function initLighting(e) {
  env = e;
  const pane = document.getElementById('paneLayers');
  if (pane) {
    const box = document.createElement('div');
    box.innerHTML = `
      <h3>Lighting</h3>
      <label class="row tglbtn" title="Lights, shadows and glowing screens as in Starlight (a powered station)">
        <input type="checkbox" data-k="on"> Realistic lighting</label>
      <div class="lgtopts">
        <label class="row tglbtn" title="Ambient occlusion: a soft dark rim along walls"><input type="checkbox" data-k="ao"> Wall shading</label>
        <label class="row tglbtn"><input type="checkbox" data-k="bloom"> Bloom</label>
        <label class="row tglbtn"><input type="checkbox" data-k="vignette"> Vignette</label>
        <label class="row tglbtn"><input type="checkbox" data-k="grain"> Film grain</label>
        <label class="row tglbtn" title="Lights whose objects are hidden by the layers above still shine"><input type="checkbox" data-k="hiddenLights"> Lights from hidden objects</label>
        <label class="row">Unlit areas <input type="range" id="lgtAmb" min="0" max="0.3" step="0.01" value="${st.ambient}" style="flex:1"></label>
      </div>
      <label class="row tglbtn" title="See the station as from where the cursor is, with the game's own field of view"><input type="checkbox" data-k="gameView"> Game view at the cursor</label>
      <p class="hint" id="lgtNote"></p>`;
    pane.appendChild(box);
    box.querySelectorAll('input[data-k]').forEach(inp => {
      inp.checked = !!st[inp.dataset.k];
      inp.onchange = () => {
        st[inp.dataset.k] = inp.checked; saveSt();
        if (inp.dataset.k === 'on' || inp.dataset.k === 'hiddenLights') job = null;
        box.querySelector('.lgtopts').hidden = !st.on;
        if (!st.on) note('');
        env.redraw();
      };
    });
    box.querySelector('.lgtopts').hidden = !st.on;
    box.querySelector('#lgtAmb').onchange = (ev) => { st.ambient = +ev.target.value; saveSt(); job = null; env.redraw(); };
  }
  // own canvases over the map (below the selection/drawing overlay)
  const stage = document.getElementById('stage'), over = document.getElementById('overlayCanvas');
  const mk = (blend) => {
    const c = document.createElement('canvas');
    c.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;${blend ? 'mix-blend-mode:' + blend + ';' : ''}`;
    stage.insertBefore(c, over);
    return c;
  };
  cvFov = mk(''); cvBloom = mk('screen'); cvFx = mk('');
  grainEl = document.createElement('div');
  grainEl.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:overlay;display:none;';
  grainEl.style.backgroundImage = `url(${grainTile()})`;
  grainEl.animate([{ backgroundPosition: '0px 0px' }, { backgroundPosition: '137px 89px' }],
    { duration: 1000, iterations: Infinity, easing: 'steps(24)' });
  stage.insertBefore(grainEl, over);
  over.addEventListener('pointermove', (ev) => { cursor = [ev.offsetX, ev.offsetY]; if (st.gameView) queueFov(); });
  over.addEventListener('pointerleave', () => { cursor = null; if (st.gameView) queueFov(); });
}

function note(t) { const n = document.getElementById('lgtNote'); if (n) n.textContent = t; }

function loadData(fork) {
  if (!data.has(fork)) {
    data.set(fork, fetch(`db/lights-${fork}.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { ent: {} }).then(j => j.ent || {}).catch(() => ({})));
  }
  return data.get(fork);
}

// film grain: a grey noise tile; Starlight's strength (0.05) through an overlay blend
function grainTile() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), im = g.createImageData(256, 256);
  for (let i = 0; i < im.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255 * GRAIN * 2;
    im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL();
}

// tiles that block sight and light: walls, closed solid doors…
function blockers(scene, grid) {
  const op = new Set();
  for (const it of scene.items) {
    if (it.kind !== 'ent' || it.grid !== grid || !it.info || !it.info.oc) continue;
    if (it.info.door != null && it.door === 'open') continue;
    op.add(K(it.tx, it.ty));
  }
  return op;
}

// which lights take part (lights of hidden objects only if asked)
const lightOn = (R, it) => st.hiddenLights || R.visible(it);
function lightKey(scene, R, ents) {
  let n = 0, h = 0;
  for (const it of scene.items) {
    if (it.kind !== 'ent') continue;
    const L = ents[it.proto];
    if (!L || !L.pl || !lightOn(R, it)) continue;
    n++; h = (h * 31 + (it.uid | 0)) | 0;
  }
  return n + ':' + h;
}

// ---------------------------------------------------------------- building the light maps
function startJob() {
  const scene = env.getScene(), R = env.getRenderer(), fork = env.getFork();
  const myJob = { scene, fork, amb: st.ambient, hidden: st.hiddenLights, key: null, grids: new Map(), ready: false, lights: null };
  job = myJob;
  note('Lighting: preparing…');
  loadData(fork).then(async (ents) => {
    if (job !== myJob) return;
    myJob.lights = ents;
    if (!Object.keys(ents).length) { note('No light data for this server yet.'); return; }
    myJob.key = lightKey(scene, R, ents);
    let total = 0, done = 0;
    const work = [];
    for (const gr of R.grids.values()) {
      if (!isFinite(gr.minX)) continue;
      const opaque = blockers(scene, gr.uid);
      const sources = [];
      for (const it of scene.items) {
        if (it.kind !== 'ent' || it.grid !== gr.uid) continue;
        const L = ents[it.proto];
        if (L && L.pl && lightOn(R, it)) sources.push([it, L.pl]);
      }
      total += sources.length;
      work.push({ gr, opaque, sources });
    }
    for (const w of work) {
      const lm = newLightMap(w.gr, scene, w.opaque);
      myJob.grids.set(w.gr.uid, lm);
      const targets = corners(w.opaque);
      for (let i = 0; i < w.sources.length; i++) {
        if (job !== myJob) return;
        addLight(lm, w.opaque, targets, w.sources[i][0], w.sources[i][1]);
        done++;
        if (i % 60 === 59) { note(`Lighting: ${done} / ${total} lights…`); await new Promise(r => setTimeout(r, 0)); }
      }
      finishLightMap(lm, w.opaque, myJob.amb);
      lm.ao = buildAO(lm, w.opaque);
    }
    if (job !== myJob) return;
    myJob.ready = true;
    note(`${total} lights, powered station assumed.`);
    env.redraw();
  });
}

function newLightMap(gr, scene, opaque) {
  const area = (gr.maxX - gr.minX) * (gr.maxY - gr.minY);
  const P = area > 250000 ? 6 : 8;           // light-map pixels per tile (fine enough for crisp corner shadows)
  const x0 = Math.floor(gr.minX) - 2, y1 = Math.ceil(gr.maxY) + 2;
  const w = Math.ceil(gr.maxX) + 2 - x0, h = y1 - (Math.floor(gr.minY) - 2);
  const c = document.createElement('canvas');
  c.width = w * P; c.height = h * P;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const station = new Set();                  // everything on the grid gets lit (lattice too); only the background doesn't
  for (const t of (scene.tiles.get(gr.uid) || [])) station.add(K(t.x, t.y));
  for (const k of opaque) station.add(k);
  return { canvas: c, g, P, x0, y1, w, h, station, tileLight: new Map() };
}

function corners(opaque) {
  const out = [], seen = new Set();
  const has = (x, y) => opaque.has(K(x, y)) ? 1 : 0;
  for (const k of opaque) {
    const x = tileX(k), y = tileY(k);
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

// the engine's point light falloff (Robust light_shared.swsl), light height 1 tile
function falloff(d, R, falloffK, curve) {
  const s = Math.min(1, Math.max(0, Math.sqrt(d * d + 1) / R)), s2 = s * s;
  const cf = s + (s2 - s) * Math.min(1, Math.max(0, curve));
  return Math.min(1, Math.max(0, ((1 - s2) * (1 - s2)) / (1 + falloffK * cf)));
}

const toLin = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const toSrgb = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

// lights add up in linear colour, at half strength so sums up to 2 fit in the 8-bit canvas
function addLight(lm, opaque, targets, it, pl) {
  const [R, energy, , fk, curve, col, ox, oy, shadows] = pl;
  const c = Math.cos(it.rot || 0), s = Math.sin(it.rot || 0);
  let px = it.x + ox * c - oy * s, py = it.y + ox * s + oy * c;   // the offset turns with the entity
  if (opaque.has(K(Math.floor(px), Math.floor(py)))) { px = it.x; py = it.y; }
  const { g, P, x0, y1 } = lm;
  const toX = (x) => (x - x0) * P, toY = (y) => (y1 - y) * P;
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
  const lr = toLin(parseInt(col.slice(1, 3), 16) / 255), lg = toLin(parseInt(col.slice(3, 5), 16) / 255), lb = toLin(parseInt(col.slice(5, 7), 16) / 255);
  const grad = g.createRadialGradient(toX(px), toY(py), 0, toX(px), toY(py), R * P);
  for (let i = 0; i <= 20; i++) {
    const v = falloff(R * i / 20, R, fk, curve) * energy * 0.5 * 255;
    grad.addColorStop(i / 20, `rgb(${Math.min(255, Math.round(lr * v))},${Math.min(255, Math.round(lg * v))},${Math.min(255, Math.round(lb * v))})`);
  }
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = grad;
  g.fill(path);
  g.restore();
}

// Starlight tonemap of linear light, gamma-encoded to 0..255
function tone(r, gg, b) {
  const peak = Math.max(r, gg, b);
  if (peak > TONE_KNEE) {
    const range = TONE_MAX - TONE_KNEE, k = (TONE_KNEE + range * (1 - Math.exp(-(peak - TONE_KNEE) / range))) / peak;
    r *= k; gg *= k; b *= k;
  }
  return [toSrgb(Math.min(1, Math.max(0, r))) * 255, toSrgb(Math.min(1, Math.max(0, gg))) * 255, toSrgb(Math.min(1, Math.max(0, b))) * 255];
}

// tonemap (Starlight), wall bleed, gamma-encode for the sRGB world, and blur as the engine does
function finishLightMap(lm, opaque, amb) {
  const { canvas, g, P, x0, y1, station, tileLight } = lm;
  const W = canvas.width, d = g.getImageData(0, 0, W, canvas.height).data;
  const out = new Uint8ClampedArray(d.length).fill(255);    // space keeps its own colours
  const idx = (x, y, xx, yy) => (((y1 - y - 1) * P + yy) * W + (x - x0) * P + xx) * 4;
  const shade = (i) => tone(d[i] / 255 * 2 + amb, d[i + 1] / 255 * 2 + amb, d[i + 2] / 255 * 2 + amb);
  lm.raw = d;                                               // the lights before all this (game view starts from it)
  for (const k of station) {
    if (opaque.has(k)) continue;
    const x = tileX(k), y = tileY(k);
    for (let yy = 0; yy < P; yy++) for (let xx = 0; xx < P; xx++) {
      const i = idx(x, y, xx, yy);
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && amb === 0) { out[i] = out[i + 1] = out[i + 2] = 0; continue; }
      const v = shade(i);
      out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2];
    }
    tileLight.set(k, shade(idx(x, y, P >> 1, P >> 1)));
  }
  // walls: the floor light blurred into them, as the engine's wall bleed
  const src = new Uint8ClampedArray(d.length);              // floor light only
  for (const k of station) {
    if (opaque.has(k)) continue;
    const x = tileX(k), y = tileY(k);
    for (let yy = 0; yy < P; yy++) for (let xx = 0; xx < P; xx++) {
      const i = idx(x, y, xx, yy);
      src[i] = out[i]; src[i + 1] = out[i + 1]; src[i + 2] = out[i + 2]; src[i + 3] = 255;
    }
  }
  const sc = document.createElement('canvas'); sc.width = W; sc.height = canvas.height;
  sc.getContext('2d').putImageData(new ImageData(src, W, canvas.height), 0, 0);
  const bc = document.createElement('canvas'); bc.width = W; bc.height = canvas.height;
  const bcg = bc.getContext('2d');
  bcg.filter = `blur(${Math.max(1, P * 0.5)}px)`;
  bcg.drawImage(sc, 0, 0);
  const bl = bcg.getImageData(0, 0, W, canvas.height).data;
  const a0 = toSrgb(Math.min(1, amb)) * 255;
  for (const k of opaque) {
    const x = tileX(k), y = tileY(k);
    for (let yy = 0; yy < P; yy++) for (let xx = 0; xx < P; xx++) {
      const i = idx(x, y, xx, yy), al = bl[i + 3];
      out[i] = al ? Math.max(a0, bl[i]) : a0; out[i + 1] = al ? Math.max(a0, bl[i + 1]) : a0; out[i + 2] = al ? Math.max(a0, bl[i + 2]) : a0;
    }
  }
  g.putImageData(new ImageData(out, W, canvas.height), 0, 0);
  const soft = document.createElement('canvas');
  soft.width = W; soft.height = canvas.height;
  const sg = soft.getContext('2d');
  sg.filter = `blur(${Math.max(1, P * 0.12)}px)`;
  sg.drawImage(canvas, 0, 0);
  lm.canvas = soft; lm.g = null;
}

// ambient occlusion: walls grown by 4 px, blurred, laid on floors only
function buildAO(lm, opaque) {
  const { P, x0, y1, w, h, station } = lm;
  const raw = document.createElement('canvas');
  raw.width = w * P; raw.height = h * P;
  const rg = raw.getContext('2d');
  rg.fillStyle = '#000';
  const e = AO_DIST * P, walls = new Path2D();
  for (const k of opaque) walls.rect((tileX(k) - x0) * P - e, (y1 - tileY(k) - 1) * P - e, P + 2 * e, P + 2 * e);
  rg.fill(walls);
  const c = document.createElement('canvas');
  c.width = w * P; c.height = h * P;
  const g = c.getContext('2d');
  g.filter = `blur(${Math.max(1, P * 0.35)}px)`;   // one blur for the whole map
  g.drawImage(raw, 0, 0);
  g.filter = 'none';
  g.globalCompositeOperation = 'destination-in';   // only on floor: not in space, not on walls
  const m = new Path2D();
  for (const k of station) if (!opaque.has(k)) m.rect((tileX(k) - x0) * P, (y1 - tileY(k) - 1) * P, P, P);
  g.fill(m);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = `rgba(${AO_COLOR.join(',')},${AO_ALPHA})`;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------- drawing (called by app.js after the map)
export function drawLighting(g, setGridXf, frame, overview) {
  if (!env || !cvFov) return;
  syncCanvases(g.canvas);
  const scene = env.getScene(), R = env.getRenderer();
  const lit = !!(st.on && scene && R.grids);
  if (lit) {
    if (!job || job.scene !== scene || job.fork !== env.getFork() || job.amb !== st.ambient || job.hidden !== st.hiddenLights) startJob();
    else if (job.ready && job.lights && !relightTimer && lightKey(scene, R, job.lights) !== job.key) {
      // layers changed which lights are shown: rebuild once things settle
      relightTimer = setTimeout(() => { relightTimer = 0; if (job && job.ready && lightKey(env.getScene(), env.getRenderer(), job.lights) !== job.key) { job = null; env.redraw(); } }, 600);
    }
  }
  const ready = !!(lit && job && job.ready);
  computeEye();
  if (ready) {
    const { PX, CHUNK } = env;
    for (const gr of R.grids.values()) {
      const lm = job.grids.get(gr.uid);
      if (!lm) continue;
      setGridXf(g, gr);
      const place = (c) => { g.save(); g.imageSmoothingEnabled = true; g.translate(lm.x0, lm.y1); g.scale(1 / lm.P, -1 / lm.P); g.drawImage(c, 0, 0); g.restore(); };
      if (st.ao && lm.ao) place(lm.ao);
      const el = eye && eye.gr === gr ? eyeLight(lm, eye) : null;
      g.save(); g.globalCompositeOperation = 'multiply';
      if (el) { g.imageSmoothingEnabled = true; g.translate(el.tx0, el.ty1); g.scale(1 / el.P, -1 / el.P); g.drawImage(el.canvas, 0, 0); }
      else place(lm.canvas);
      g.restore();
      if (overview) continue;
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
  drawFov(setGridXf);
  drawPost(g.canvas, setGridXf, ready);
}

function syncCanvases(map) {
  for (const c of [cvFov, cvBloom, cvFx]) {
    if (c.width !== map.width || c.height !== map.height) { c.width = map.width; c.height = map.height; }
    c.style.height = map.style.height || '100%';
  }
  grainEl.style.height = map.style.height || '100%';
}

// bloom (what glows above the light it gets), vignette, film grain
function drawPost(map, setGridXf, ready) {
  const R = env.getRenderer();
  const bg = cvBloom.getContext('2d'), fg = cvFx.getContext('2d');
  bg.setTransform(1, 0, 0, 1, 0, 0); bg.clearRect(0, 0, cvBloom.width, cvBloom.height);
  fg.setTransform(1, 0, 0, 1, 0, 0); fg.clearRect(0, 0, cvFx.width, cvFx.height);
  grainEl.style.display = ready && st.grain ? '' : 'none';
  if (!ready) return;
  if (st.bloom) {
    const s = 4, w = Math.max(1, Math.ceil(map.width / s)), h = Math.max(1, Math.ceil(map.height / s));
    const sc = document.createElement('canvas'); sc.width = w; sc.height = h;
    const sg = sc.getContext('2d');
    sg.drawImage(map, 0, 0, w, h);
    const lc = document.createElement('canvas'); lc.width = w; lc.height = h;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#fff'; lg.fillRect(0, 0, w, h);
    lg.scale(1 / s, 1 / s);
    for (const gr of R.grids.values()) {
      const lm = job.grids.get(gr.uid);
      if (!lm) continue;
      lg.save();
      setGridXf(lg, gr);
      const m = lg.getTransform();
      lg.setTransform(m.a / s, m.b / s, m.c / s, m.d / s, m.e / s, m.f / s);
      lg.imageSmoothingEnabled = true; lg.translate(lm.x0, lm.y1); lg.scale(1 / lm.P, -1 / lm.P); lg.drawImage(lm.canvas, 0, 0);
      lg.restore();
    }
    try {
      const a = sg.getImageData(0, 0, w, h), l = lg.getImageData(0, 0, w, h).data, d = a.data;
      let fov = null;
      if (st.gameView && lastFovMask) {
        const fc = document.createElement('canvas'); fc.width = w; fc.height = h;
        const fcg = fc.getContext('2d'); fcg.drawImage(lastFovMask, 0, 0, w, h);
        fov = fcg.getImageData(0, 0, w, h).data;
      }
      for (let i = 0; i < d.length; i += 4) {
        const r = Math.max(0, d[i] - l[i] * LIT_ALBEDO), gg = Math.max(0, d[i + 1] - l[i + 1] * LIT_ALBEDO), b = Math.max(0, d[i + 2] - l[i + 2] * LIT_ALBEDO);
        const peak = Math.max(r, gg, b) / 255;
        const t = Math.min(1, Math.max(0, (peak - BLOOM_THRESHOLD) / 0.25));
        let k = t * t * (3 - 2 * t) * BLOOM_STRENGTH;
        if (fov) k *= 1 - fov[i + 3] / 255;       // nothing glows out of sight
        d[i] = r * k; d[i + 1] = gg * k; d[i + 2] = b * k; d[i + 3] = 255;
      }
      sg.putImageData(a, 0, 0);
      bg.filter = `blur(${Math.max(2, map.width / 160)}px)`;
      bg.drawImage(sc, 0, 0, map.width, map.height);
      bg.filter = 'none';
    } catch (e) { /* a canvas that can't be read: no bloom */ }
  }
  if (st.vignette) {
    const w = cvFx.width, h = cvFx.height, r = Math.hypot(w, h) / 2;
    const grad = fg.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r);
    for (let i = 0; i <= 10; i++) {
      const dd = i / 10, t = Math.min(1, Math.max(0, (dd - 0.4) / 0.6));
      grad.addColorStop(dd, `rgba(0,0,0,${VIGNETTE * t * t * (3 - 2 * t)})`);
    }
    fg.fillStyle = grad;
    fg.fillRect(0, 0, w, h);
  }
}

// ---------------------------------------------------------------- game view at the cursor
// The FOV itself is the engine's, ported in robust-fov.js. Here: the eye under the cursor, the final FOV
// (black past the walls) and, with lighting on, the engine's lighting FOV and wall bleed for that eye.
function queueFov() {
  if (fovRaf) return;
  fovRaf = requestAnimationFrame(() => { fovRaf = 0; env.redraw(); });
}

const geomCache = new WeakMap();   // grid -> { scene, geom }
let eye = null, eyeMemo = null, lightMemo = null;

function computeEye() {
  eye = null;
  const scene = env.getScene(), R = env.getRenderer();
  if (!st.gameView || !cursor || !scene || !R.grids) return;
  const [wx, wy] = env.toWorld(cursor[0], cursor[1]);
  let gr = null;                               // the grid under the cursor
  for (const c of R.grids.values()) {
    const [lx, ly] = env.gridLocal(c, wx, wy);
    if (lx >= c.minX - 1 && lx <= c.maxX + 1 && ly >= c.minY - 1 && ly <= c.maxY + 1) { gr = c; break; }
  }
  if (!gr) return;
  const [lx, ly] = env.gridLocal(gr, wx, wy);
  let gc = geomCache.get(gr);
  if (!gc || gc.scene !== scene) { gc = { scene, geom: buildOccluderGeometry(scene.items, gr.uid) }; geomCache.set(gr, gc); }
  const range = Math.min(60, Math.hypot(cvFov.width, cvFov.height) / (2 * (window.devicePixelRatio || 1) * env.camScale()) + 2);
  if (eyeMemo && eyeMemo.gr === gr && eyeMemo.geom === gc.geom && eyeMemo.lx === lx && eyeMemo.ly === ly && eyeMemo.range === range) { eye = eyeMemo; return; }
  const fov = computeFov(gc.geom, lx, ly, range);
  eye = eyeMemo = { gr, geom: gc.geom, lx, ly, range, fov, poly: fovPolygon(fov, range) };
}

// fov.swsl: everything not in view is black
function drawFov(setGridXf) {
  const g = cvFov.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cvFov.width, cvFov.height);
  lastFovMask = null;
  if (!eye) return;
  const p = eye.poly, vis = new Path2D();
  vis.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) vis.lineTo(p[i], p[i + 1]);
  vis.closePath();
  g.fillStyle = '#000';
  g.fillRect(0, 0, cvFov.width, cvFov.height);
  g.save();
  setGridXf(g, eye.gr);
  g.globalCompositeOperation = 'destination-out';
  g.fill(vis);
  g.restore();
  lastFovMask = cvFov;
}

// The engine's light pass for this eye, on the light map's pixels around what is in view:
// clear to the ambient, fov-lighting.swsl (darkens the ambient, no lights where not fully in view),
// the lights, light blur (light.blur_factor 0.001 x 14), BlurOntoWalls (3 gaussian passes with x1.1 each
// way) merged onto the occluders only (MergeWallLayer); then the Starlight tonemap as the rest of the map.
function eyeLight(lm, e) {
  if (lightMemo && lightMemo.e === e && lightMemo.lm === lm && lightMemo.amb === st.ambient) return lightMemo.out;
  const { P, x0, y1, station, raw } = lm;
  if (!raw) return null;
  const p = e.poly;
  let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { mx0 = Math.min(mx0, p[i]); mx1 = Math.max(mx1, p[i]); my0 = Math.min(my0, p[i + 1]); my1 = Math.max(my1, p[i + 1]); }
  const tx0 = Math.max(x0, Math.floor(mx0) - 2), tx1 = Math.min(x0 + lm.w, Math.ceil(mx1) + 2);
  const ty0 = Math.max(y1 - lm.h, Math.floor(my0) - 2), ty1 = Math.min(y1, Math.ceil(my1) + 2);
  const W = (tx1 - tx0) * P, H = (ty1 - ty0) * P;
  if (W <= 0 || H <= 0) return null;
  const RW = lm.w * P, ox = (tx0 - x0) * P, oy = (y1 - ty1) * P, n = W * H, amb = st.ambient;
  const buf = new Float32Array(n * 3), onStation = new Uint8Array(n);
  const tw = tx1 - tx0, rowSt = new Uint8Array(tw);
  for (let py = 0; py < H; py++) {
    const wy = ty1 - (py + 0.5) / P, ty = ty1 - 1 - Math.floor(py / P);
    if (py % P === 0) for (let t = 0; t < tw; t++) rowSt[t] = station.has(K(tx0 + t, ty)) ? 1 : 0;
    for (let px = 0; px < W; px++) {
      const j = py * W + px;
      onStation[j] = rowSt[(px / P) | 0];
      const occ = lightingOcclusion(e.fov, tx0 + (px + 0.5) / P, wy);
      const ri = ((oy + py) * RW + ox + px) * 4, lit = occ >= 1;
      buf[j * 3] = (lit ? raw[ri] / 255 * 2 : 0) + amb * occ;
      buf[j * 3 + 1] = (lit ? raw[ri + 1] / 255 * 2 : 0) + amb * occ;
      buf[j * 3 + 2] = (lit ? raw[ri + 2] / 255 * 2 : 0) + amb * occ;
    }
  }
  const tmp = new Float32Array(n * 3);
  for (let i = 3; i > 0; i--) {                  // light blur
    const o = (i + 1) * 0.001 * 14 * P;
    blurPass(buf, tmp, W, H, o, true, 1); blurPass(tmp, buf, W, H, o, false, 1);
  }
  const wb = Float32Array.from(buf);
  for (let i = 3; i > 0; i--) {                  // wall bleed
    const o = (i + 1) * 7e-3 * 14 * P;
    blurPass(wb, tmp, W, H, o, true, 1.1); blurPass(tmp, wb, W, H, o, false, 1.1);
  }
  const mc = document.createElement('canvas'); mc.width = W; mc.height = H;
  const mg = mc.getContext('2d');
  mg.setTransform(P, 0, 0, -P, -tx0 * P, ty1 * P);
  const walls = new Path2D();
  for (const o of e.geom.occ) {
    if (o.x1 < tx0 || o.x0 > tx1 || o.y1 < ty0 || o.y0 > ty1) continue;
    walls.moveTo(o.verts[0][0], o.verts[0][1]);
    for (let i = 1; i < o.verts.length; i++) walls.lineTo(o.verts[i][0], o.verts[i][1]);
    walls.closePath();
  }
  mg.fill(walls);
  const mask = mg.getImageData(0, 0, W, H).data;
  const out = new Uint8ClampedArray(n * 4);
  for (let j = 0; j < n; j++) {
    const o = j * 4;
    out[o + 3] = 255;
    if (!onStation[j]) { out[o] = out[o + 1] = out[o + 2] = 255; continue; }   // space keeps its own colours
    const src = mask[o + 3] > 127 ? wb : buf;
    const v = tone(src[j * 3], src[j * 3 + 1], src[j * 3 + 2]);
    out[o] = v[0]; out[o + 1] = v[1]; out[o + 2] = v[2];
  }
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
  const res = { canvas: c, tx0, ty1, P };
  lightMemo = { e, lm, amb: st.ambient, out: res };
  return res;
}

// one direction of the engine's 5-tap blur (light-blur / wall-bleed-blur.swsl), linear sampling, clamped
function blurPass(src, dst, W, H, o, horiz, gain) {
  const len = horiz ? W : H, lines = horiz ? H : W, step = horiz ? 1 : W, lstep = horiz ? W : 1;
  const taps = [[o, 0.25], [-o, 0.25], [2 * o, 0.0625], [-2 * o, 0.0625]].map(([t, w]) => { const d = Math.floor(t); return [d, t - d, w]; });
  for (let b = 0; b < lines; b++) {
    const base = b * lstep;
    for (let i = 0; i < len; i++) {
      const k = (base + i * step) * 3;
      let r = src[k] * 0.375, g = src[k + 1] * 0.375, bl = src[k + 2] * 0.375;
      for (let q = 0; q < 4; q++) {
        const tp = taps[q], j0 = i + tp[0], fr = tp[1], w = tp[2];
        const a0 = (base + (j0 < 0 ? 0 : j0 >= len ? len - 1 : j0) * step) * 3;
        const j1 = j0 + 1, a1 = (base + (j1 < 0 ? 0 : j1 >= len ? len - 1 : j1) * step) * 3;
        const w0 = w * (1 - fr), w1 = w * fr;
        r += src[a0] * w0 + src[a1] * w1; g += src[a0 + 1] * w0 + src[a1 + 1] * w1; bl += src[a0 + 2] * w0 + src[a1 + 2] * w1;
      }
      dst[k] = r * gain; dst[k + 1] = g * gain; dst[k + 2] = bl * gain;
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
