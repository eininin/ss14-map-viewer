// Station Guesser: a view from a random spot of the map on the left, the outline of the
// station on the right; click the outline where you think the view is.
import { eyePolygon, sightTargets, seenTiles, tileX, tileY, tileKey } from './fov.js?v=27';

const LSK = 'ss14mv.guess';
const load = () => { try { return JSON.parse(localStorage.getItem(LSK)) || {}; } catch (e) { return {}; } };
const save = (o) => { try { localStorage.setItem(LSK, JSON.stringify(o)); } catch (e) { /* ignore */ } };

/**
 * @param {object} ctx
 *   renderer, scene, grid (uid), CHUNK, PX, sightBlockers(grid, doorsOpen) -> Set, mapName
 */
export function openGuesser(ctx) {
  const opt = { size: 5, fog: true, rot: 'none', doorsOpen: false, walls: true, ...load() };
  if (opt.rot !== 'none') opt.rot = '90';
  const { renderer: R, scene, grid, CHUNK, PX } = ctx;
  const gr = R.grids && R.grids.get(grid);
  if (!gr) return 'This map has no station grid to play on';
  const tiles = (scene.tiles.get(grid) || []);
  const floor = new Set(tiles.map(t => tileKey(t.x, t.y)));
  let opaque = ctx.sightBlockers(grid, opt.doorsOpen), targets = sightTargets(opaque);
  const spots = () => tiles.filter(t => !/lattice/i.test(t.name) && !opaque.has(tileKey(t.x, t.y)));
  let pool = spots();
  if (!pool.length) return 'No floor on this map to pick a spot from';

  const el = document.createElement('div');
  el.className = 'gmodal';
  el.innerHTML = `
    <div class="gbar">
      <b>Station Guesser</b><span class="gmap"></span>
      <label>View <input type="number" class="gsize" min="1" max="61" step="1" value="${opt.size}"> tiles</label>
      <label class="tglbtn" title="Black out everything the spot cannot see"><input type="checkbox" class="gfog" ${opt.fog ? 'checked' : ''}> field of view</label>
      <label class="tglbtn" title="Show walls on the station outline"><input type="checkbox" class="gwalls" ${opt.walls ? 'checked' : ''}> walls on map</label>
      <label class="tglbtn" title="Solid airlocks count as open for the field of view"><input type="checkbox" class="gdoor" ${opt.doorsOpen ? 'checked' : ''}> airlocks open</label>
      <label>Rotation <select class="sel grot">
        <option value="none">none</option><option value="90">random quarter turns</option>
      </select></label>
      <span class="gscore"></span>
      <button class="btn small gnew">New spot</button>
      <button class="btn small gclose" title="Esc">Close</button>
    </div>
    <div class="gbody">
      <div class="gside"><canvas class="gview"></canvas><div class="gnote"></div></div>
      <div class="gside"><canvas class="gout"></canvas><div class="gresult">Click the station where you think this is.</div></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.grot').value = opt.rot;
  el.querySelector('.gmap').textContent = ctx.mapName || '';
  const cv = el.querySelector('.gview'), co = el.querySelector('.gout');
  const res = el.querySelector('.gresult'), scoreEl = el.querySelector('.gscore'), note = el.querySelector('.gnote');

  let spot = null, angle = 0, guess = null, rounds = 0, total = 0;
  const dpr = window.devicePixelRatio || 1;

  // ---- outline of the station (fixed, north up)
  const [bx0, by0, bx1, by1] = [Math.floor(gr.minX) - 1, Math.floor(gr.minY) - 1, Math.ceil(gr.maxX) + 1, Math.ceil(gr.maxY) + 1];
  let ow = 0, oh = 0, os = 1;
  function sizeAll() {
    const body = el.querySelector('.gbody').getBoundingClientRect();
    const side = Math.max(200, Math.min(body.width / 2 - 24, body.height - 40));
    cv.style.width = cv.style.height = side + 'px';
    cv.width = cv.height = Math.round(side * dpr);
    os = Math.min((body.width / 2 - 24) / (bx1 - bx0), (body.height - 40) / (by1 - by0));
    ow = Math.round((bx1 - bx0) * os); oh = Math.round((by1 - by0) * os);
    co.style.width = ow + 'px'; co.style.height = oh + 'px';
    co.width = Math.round(ow * dpr); co.height = Math.round(oh * dpr);
    drawView(); drawOutline();
  }
  const toOut = (x, y) => [(x - bx0) * os, (by1 - y) * os];
  function drawOutline() {
    const g = co.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ow, oh);
    for (const t of tiles) {
      const k = tileKey(t.x, t.y);
      g.fillStyle = opaque.has(k) && opt.walls ? '#9aa6b8' : /lattice/i.test(t.name) ? '#262c35' : '#424b58';
      const [x, y] = toOut(t.x, t.y + 1);
      g.fillRect(x, y, os + 0.3, os + 0.3);
    }
    if (opt.walls) for (const k of opaque) if (!floor.has(k)) {   // walls on lattice etc.
      const x = Math.floor(k / 65536) - 32768, y = (k % 65536) - 32768;
      const [sx, sy] = toOut(x, y + 1);
      g.fillStyle = '#9aa6b8';
      g.fillRect(sx, sy, os + 0.3, os + 0.3);
    }
    if (guess) {
      const [gx, gy] = toOut(guess[0], guess[1]);
      const [ax, ay] = toOut(spot.x + 0.5, spot.y + 0.5);
      g.strokeStyle = '#fff'; g.setLineDash([5, 4]); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(gx, gy); g.lineTo(ax, ay); g.stroke(); g.setLineDash([]);
      const half = opt.size / 2;
      g.strokeStyle = '#7bd88f'; g.lineWidth = 2;
      const [rx, ry] = toOut(spot.x + 0.5 - half, spot.y + 0.5 + half);
      g.strokeRect(rx, ry, opt.size * os, opt.size * os);
      dot(g, ax, ay, '#7bd88f'); dot(g, gx, gy, '#ff5c8a');
    }
  }
  const dot = (g, x, y, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); };

  // ---- the view
  function drawView() {
    if (!spot) return;
    const g = cv.getContext('2d'), S = cv.width, n = opt.size, pt = S / n;
    const px = spot.x + 0.5, py = spot.y + 0.5;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    const xf = () => { g.setTransform(1, 0, 0, 1, 0, 0); g.translate(S / 2, S / 2); g.rotate(-angle); g.scale(pt, -pt); g.translate(-px, -py); };
    xf();
    g.imageSmoothingEnabled = n > 12;
    const reach = n * 0.75 + 1;
    const c0x = Math.floor((px - reach) / CHUNK), c1x = Math.floor((px + reach) / CHUNK);
    const c0y = Math.floor((py - reach) / CHUNK), c1y = Math.floor((py + reach) / CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
      const c = gr.chunks.get(cx + ',' + cy);
      if (!c) continue;
      if (!c.canvas) R.renderChunk(gr, c);
      c.used = performance.now();
      g.save();
      g.translate(cx * CHUNK, (cy + 1) * CHUNK);
      g.scale(1 / PX, -1 / PX);
      g.drawImage(c.canvas, 0, 0);
      g.restore();
    }
    if (opt.fog) {
      // black out what the spot can't see; walls it touches are seen whole
      const p = eyePolygon(opaque, targets, px, py, reach + 2);
      const seen = seenTiles([p], opaque, 8);
      const m = document.createElement('canvas');
      m.width = S; m.height = S;
      const mg = m.getContext('2d');
      mg.fillStyle = '#000';
      mg.fillRect(0, 0, S, S);
      mg.setTransform(g.getTransform());
      mg.globalCompositeOperation = 'destination-out';
      const vis = new Path2D();
      vis.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) vis.lineTo(p[i], p[i + 1]);
      vis.closePath();
      for (const k of seen) if (opaque.has(k)) vis.rect(tileX(k), tileY(k), 1, 1);
      mg.fill(vis);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(m, 0, 0);
    }
    // the spot itself
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = 'rgba(255,255,255,.7)';
    g.lineWidth = Math.max(1, dpr);
    const r = Math.max(4, pt * 0.18);
    g.beginPath(); g.moveTo(S / 2 - r, S / 2); g.lineTo(S / 2 + r, S / 2); g.moveTo(S / 2, S / 2 - r); g.lineTo(S / 2, S / 2 + r); g.stroke();
    note.textContent = opt.rot === 'none' ? 'North is up.' : 'The view may be turned.';
  }

  function newSpot() {
    spot = pool[Math.floor(Math.random() * pool.length)];
    angle = opt.rot === '90' ? Math.floor(Math.random() * 4) * Math.PI / 2 : 0;
    R.setViewRot(angle);                      // sprites drawn as seen from that direction
    guess = null;
    res.textContent = 'Click the station where you think this is.';
    drawView(); drawOutline();
  }
  function showScore() { scoreEl.textContent = rounds ? `${total} pts · ${rounds} round${rounds > 1 ? 's' : ''}` : ''; }

  co.addEventListener('click', (e) => {
    if (!spot || guess) return;
    const r = co.getBoundingClientRect();
    const x = (e.clientX - r.left) / os + bx0, y = by1 - (e.clientY - r.top) / os;
    guess = [x, y];
    const d = Math.hypot(x - (spot.x + 0.5), y - (spot.y + 0.5));
    const scale = Math.max(6, Math.hypot(bx1 - bx0, by1 - by0) / 15);
    const pts = Math.round(5000 * Math.exp(-Math.max(0, d - 0.7) / scale));
    rounds++; total += pts; showScore();
    res.innerHTML = `<b>${d < 1 ? 'Spot on!' : d.toFixed(1) + ' tiles away'}</b> · ${pts} points <button class="btn small primary gnext">Next</button>`;
    res.querySelector('.gnext').onclick = newSpot;
    drawOutline();
  });

  const reopts = (refresh) => {
    save(opt);
    if (refresh) { opaque = ctx.sightBlockers(grid, opt.doorsOpen); targets = sightTargets(opaque); pool = spots(); drawOutline(); }
    drawView();
  };
  el.querySelector('.gsize').onchange = (e) => { opt.size = Math.max(1, Math.min(61, Math.round(+e.target.value) || 5)); e.target.value = opt.size; reopts(); if (guess) drawOutline(); };
  el.querySelector('.gfog').onchange = (e) => { opt.fog = e.target.checked; reopts(); };
  el.querySelector('.gwalls').onchange = (e) => { opt.walls = e.target.checked; save(opt); drawOutline(); };
  el.querySelector('.gdoor').onchange = (e) => { opt.doorsOpen = e.target.checked; reopts(true); };
  el.querySelector('.grot').onchange = (e) => { opt.rot = e.target.value; save(opt); newSpot(); };
  el.querySelector('.gnew').onclick = newSpot;
  const close = () => { el.remove(); if (ctx.onClose) ctx.onClose(); window.removeEventListener('resize', sizeAll); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.target.matches && e.target.matches('input, select')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if ((e.key === 'Enter' || e.key === ' ') && guess) { e.preventDefault(); e.stopPropagation(); newSpot(); }
    else e.stopPropagation();                 // keep the map's shortcuts out of the game
  };
  el.querySelector('.gclose').onclick = close;
  window.addEventListener('resize', sizeAll);
  window.addEventListener('keydown', onKey, true);
  spot = pool[Math.floor(Math.random() * pool.length)];
  sizeAll();
  newSpot();
}
