// Station Guesser: a view from a spot of the map on the left, the outline of the station on the
// right; click the outline where you think the view is. Three kinds of spots:
//   photo    – "Photo from the station": inside, on a proper floor (not maints, not glass)
//   maints   – "Tider's memory": inside, in maintenance
//   training – "Random training": any floor, outside too; free view size, no timer
import { eyePolygon, sightTargets, seenTiles, tileX, tileY, tileKey } from './fov.js?v=31';

const LSK = 'ss14mv.guess';
const load = () => { try { return JSON.parse(localStorage.getItem(LSK)) || {}; } catch (e) { return {}; } };
const save = (o) => { try { localStorage.setItem(LSK, JSON.stringify(o)); } catch (e) { /* ignore */ } };
const MODES = {
  maints: { name: "Tider's memory", desc: 'Somewhere in maintenance. A bigger view, since maints all look alike.' },
  photo: { name: 'Photo from the station', desc: 'A spot in a room or hallway: real floor, not maintenance, not inside a window.' },
  items: { name: 'Item search', desc: 'Centred on a random thing: an item, machine, locker or crate somewhere on the station.' },
  training: { name: 'Random training', desc: 'Any floor at all, outside the station too. No timer.' },
};
const esc0 = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const START = 5000, GRACE = 3, ROUNDS = 12;
// what counts for item search: things lying or standing around, not walls, floors, decals or pipes
const ITEM_CATS = new Set(['items', 'machines', 'computers', 'fabrication', 'vending', 'storage']);                 // points at the start; seconds before they start to drop
let starImg = null;
// seeded games: the seed, today's date in London (changes at London midnight), the map and the mode
// together pick the spots, so a seed means the same game for everyone that day
const londonDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function hashStr(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) ^ (h1 >>> 0);
}
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const randomSeed = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

export function openGuesser(ctx) {
  const opt = { rot: 'none', walls: true, mode: 'photo', ...load() };
  opt.minutes = 3;
  opt.sizes = { maints: 7, photo: 5, items: 3, training: (opt.sizes && opt.sizes.training) || 5 };
  if (opt.rot !== 'none') opt.rot = '90';
  const { renderer: R, scene, grid, CHUNK, PX } = ctx;
  const gr = R.grids && R.grids.get(grid);
  if (!gr) return 'This map has no station grid to play on';
  const tiles = (scene.tiles.get(grid) || []);
  if (!tiles.length) return 'No floor on this map to pick a spot from';
  if (!starImg) { starImg = new Image(); starImg.src = 'img/stars-tile.webp'; }

  // ---- what is where
  const floorName = new Map(tiles.map(t => [tileKey(t.x, t.y), t.name]));
  const struct = new Set(), glass = new Set(), doors = new Set(), doorKind = new Map();   // walls/windows/doors; windows and grilles; doors
  // thin glass (directional windows, windoors): a barrier on one edge of the tile, not a full wall.
  // At rotation 0 it sits on the south edge; the edge turns with the entity.
  const thin = new Map();                     // tile -> [[dx, dy, isDoor], ...]
  for (const it of scene.items) {
    if (it.kind !== 'ent' || it.grid !== grid || !it.info) continue;
    const k = tileKey(it.tx, it.ty);
    if (/directional|windoor/i.test(it.proto) && !it.info.oc) {
      if (!thin.has(k)) thin.set(k, []);
      const c = Math.cos(it.rot), sn = Math.sin(it.rot);
      if (/corner/i.test(it.proto)) {         // corner piece: south-west corner at rotation 0; seals nothing
        thin.get(k).push([Math.round(-c + sn), Math.round(-sn - c), false, true]);
        continue;
      }
      thin.get(k).push([Math.round(sn), Math.round(-c), it.cat === 'doors', false]);
      continue;
    }
    if (it.cat === 'walls' || it.cat === 'doors' || it.info.oc) struct.add(k);
    if (it.cat === 'doors') {
      doors.add(k);
      // maintenance doors, neutral ones (firelocks, shutters, external), or department doors
      const kind = /maint/i.test(it.proto) ? 1 : /firelock|shutter|blast|external|shuttle|docking|flap|podlock/i.test(it.proto) ? 0 : 2;
      doorKind.set(k, Math.max(doorKind.get(k) || 0, kind));
    }
    if (/window|grille/i.test(it.proto) || (it.cat === 'walls' && !it.info.oc)) glass.add(k);
  }
  const isPlating = (n) => /plating|lattice|catwalk/i.test(n || '');
  const isLattice = (n) => /lattice/i.test(n || '');
  const [bx0, by0, bx1, by1] = [Math.floor(gr.minX) - 2, Math.floor(gr.minY) - 2, Math.ceil(gr.maxX) + 2, Math.ceil(gr.maxY) + 2];
  const BW = bx1 - bx0, BH = by1 - by0, idx = (x, y) => (y - by0) * BW + (x - bx0);
  const sealed = (x, y, dx, dy) => {         // is the edge between (x, y) and its neighbour closed by thin glass?
    const a = thin.get(tileKey(x, y)), b = thin.get(tileKey(x + dx, y + dy));
    return !!((a && a.some(e => !e[3] && e[0] === dx && e[1] === dy)) || (b && b.some(e => !e[3] && e[0] === -dx && e[1] === -dy)));
  };
  const step = (st, x, y) => {               // push the neighbours that are not sealed off
    if (!sealed(x, y, 1, 0)) st.push(x + 1, y);
    if (!sealed(x, y, -1, 0)) st.push(x - 1, y);
    if (!sealed(x, y, 0, 1)) st.push(x, y + 1);
    if (!sealed(x, y, 0, -1)) st.push(x, y - 1);
  };
  // outside: everything reachable from the map's edge without passing a wall, window or door
  const outside = new Uint8Array(BW * BH);
  {
    const st = [];
    for (let x = bx0; x < bx1; x++) { st.push(x, by0, x, by1 - 1); }
    for (let y = by0; y < by1; y++) { st.push(bx0, y, bx1 - 1, y); }
    while (st.length) {
      const y = st.pop(), x = st.pop();
      if (x < bx0 || y < by0 || x >= bx1 || y >= by1) continue;
      const i = idx(x, y);
      if (outside[i] || struct.has(tileKey(x, y))) continue;
      outside[i] = 1;
      step(st, x, y);
    }
  }
  // rooms: floor areas inside, split by walls, windows and doors. Maintenance = mostly plating and
  // no department door around it (maints and hidden rooms only have maintenance doors, or none;
  // engineering, atmos and other plated work rooms always have a department airlock)
  const room = new Int32Array(BW * BH).fill(-1), roomPlating = [], roomDept = [], roomSize = [];
  for (const t of tiles) {
    const k = tileKey(t.x, t.y), i0 = idx(t.x, t.y);
    if (room[i0] >= 0 || outside[i0] || struct.has(k)) continue;
    const id = roomPlating.length; let n = 0, p = 0, dept = false;
    const st = [t.x, t.y];
    while (st.length) {
      const y = st.pop(), x = st.pop(), kk = tileKey(x, y);
      if (x < bx0 || y < by0 || x >= bx1 || y >= by1) continue;
      const i = idx(x, y);
      if (doorKind.get(kk) === 2) dept = true;
      if (room[i] >= 0 || outside[i] || struct.has(kk) || !floorName.has(kk)) continue;
      room[i] = id; n++; if (isPlating(floorName.get(kk))) p++;
      step(st, x, y);
    }
    roomPlating.push(n ? p / n : 0);
    roomDept.push(dept);
    roomSize.push(n);
  }
  // the station proper: from the main hallway (the biggest area with almost no plating), through
  // every door that isn't a maintenance door (department and public airlocks, firelocks, windoors).
  // Maints and hidden rooms are what this never reaches.
  const links = roomSize.map(() => []);
  const roomAt = (x, y) => (x < bx0 || y < by0 || x >= bx1 || y >= by1) ? -1 : room[idx(x, y)];
  // doors next to each other (airlock + firelock, double doors) work as one doorway
  const doorDone = new Set();
  for (const [k0, kind0] of doorKind) {
    if (kind0 === 1 || doorDone.has(k0)) continue;
    const ids = new Set(), st = [k0];
    doorDone.add(k0);
    while (st.length) {
      const k = st.pop(), x = tileX(k), y = tileY(k);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const nk = tileKey(nx, ny), r = roomAt(nx, ny);
        if (r >= 0) ids.add(r);
        const nkind = doorKind.get(nk);
        if (nkind != null && nkind !== 1 && !doorDone.has(nk)) { doorDone.add(nk); st.push(nk); }
      }
    }
    for (const a of ids) for (const b of ids) if (a !== b) links[a].push(b);
  }
  for (const [k, list] of thin) for (const [dx, dy, isDoor, corner] of list) {
    if (!isDoor || corner) continue;
    const a = roomAt(tileX(k), tileY(k)), b = roomAt(tileX(k) + dx, tileY(k) + dy);
    if (a >= 0 && b >= 0 && a !== b) { links[a].push(b); links[b].push(a); }
  }
  let seed = -1;
  roomSize.forEach((n, i) => { if (roomPlating[i] < 0.3 && (seed < 0 || n > roomSize[seed])) seed = i; });
  const proper = new Uint8Array(roomSize.length);
  if (seed >= 0) {
    const q = [seed]; proper[seed] = 1;
    while (q.length) for (const b of links[q.pop()]) if (!proper[b]) { proper[b] = 1; q.push(b); }
  }
  const solidAround = (x, y) => {             // floor or wall in the 3x3 (walls count as floor here)
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = tileKey(x + dx, y + dy);
      if (struct.has(k) || (floorName.has(k) && !isLattice(floorName.get(k)))) c++;
    }
    return c;
  };
  // how open it is around a tile: floor tiles of the same room in the 5x5
  const openAround = (x, y, id) => {
    let c = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= bx0 && yy >= by0 && xx < bx1 && yy < by1 && room[idx(xx, yy)] === id) c++;
    }
    return c;
  };
  let opaque, targets;
  const pools = {}, byRoom = new Map();       // maints spots grouped by area, so one big area isn't picked all the time
  function buildPools() {
    opaque = ctx.sightBlockers(grid, false);
    targets = sightTargets(opaque);
    pools.photo = []; pools.maints = []; pools.items = []; pools.training = []; byRoom.clear();
    for (const t of tiles) {
      const k = tileKey(t.x, t.y);
      if (opaque.has(k)) continue;
      pools.training.push(t);
      if (struct.has(k) || glass.has(k)) continue;
      const i = idx(t.x, t.y);
      if (outside[i] || room[i] < 0) continue;
      const maintRoom = !proper[room[i]] && roomPlating[room[i]] >= 0.5;
      if (proper[room[i]] && !isPlating(t.name) && roomPlating[room[i]] < 0.5 && solidAround(t.x, t.y) >= 7) pools.photo.push(t);
      else if (maintRoom && isPlating(t.name) && !isLattice(t.name) && (roomSize[room[i]] <= 40 || openAround(t.x, t.y, room[i]) <= 13)) {
        pools.maints.push(t);                 // tunnels (narrow) and small hidden rooms, not big open plated halls
        (byRoom.get(room[i]) || byRoom.set(room[i], []).get(room[i])).push(t);
      }
    }
  }
  buildPools();
  // item search: a tile with an item lying on it, inside the station
  {
    const seenTile = new Set();
    for (const it of scene.items) {
      if (it.kind !== 'ent' || it.grid !== grid || !ITEM_CATS.has(it.cat) || it.unknown || it.hiddenSprite || it.marker || it.sub) continue;
      if (!it.layers || !it.layers.some(l => l.res && !l.res.dev && !l.hidden && !l.runtimeHidden)) continue;   // something you can see
      const k = tileKey(it.tx, it.ty);
      if (seenTile.has(k) || !floorName.has(k) || opaque.has(k)) continue;
      const i = idx(it.tx, it.ty);
      if (i < 0 || i >= outside.length || outside[i]) continue;
      seenTile.add(k);
      pools.items.push({ x: it.tx, y: it.ty, item: it.name || it.proto });
    }
  }

  // ---- page
  const el = document.createElement('div');
  el.className = 'gmodal';
  el.innerHTML = `
    <div class="gbar">
      <b>Station Guesser</b><span class="gmap"></span><span class="gmode"></span>
      <span class="gtimer"></span>
      <button class="btn small ghint" title="Show one more tile all around (H); costs 25% of the points you have">Bigger view (−25%)</button>
      <button class="btn small gfoghint" title="Lift the shadows (F); costs 25% of the points you have">No field of view (−25%)</button>
      <label class="tglbtn gwallsw" title="Walls, windows and airlocks on the station outline"><input type="checkbox" class="gwalls" ${opt.walls ? 'checked' : ''}> walls</label>
      <label class="gtrain">View <input type="number" class="gsize" min="1" max="61" step="1"> tiles</label>
      <span class="gscore"></span>
      <button class="btn small gskip">Skip</button>
      <button class="btn small gmenu">Modes</button>
      <button class="btn small gclose" title="Back to the map viewer (Esc)">Map viewer</button>
    </div>
    <div class="gstart">
      <h2>Station Guesser</h2>
      <p class="hint gmapname"></p>
      <div class="gmodes"></div>
      <div class="gopts">
        <label>Seed <input class="gseed" placeholder="empty = random" maxlength="40" value="${esc0(opt.seed || '')}"></label>
        <button class="btn small grandseed" title="Fill in a random seed">Random seed</button>
        <label>Rotation <select class="sel grot"><option value="none">north up</option><option value="90">random quarter turns</option></select></label>
      </div>
      <p class="hint">${ROUNDS} rounds. Points start at ${START} and, after ${GRACE} seconds, drain over ${3} minutes. Hints cost 25% of the
        points left: <b>bigger view</b> (H) shows one more tile all around, <b>no field of view</b> (F) lifts the shadows.
        You get the points left × how close you clicked.</p>
    </div>
    <div class="gend"></div>
    <div class="gbody">
      <div class="gside"><canvas class="gview"></canvas><div class="gnote"></div></div>
      <div class="gside"><div class="goutwrap"><canvas class="gout"></canvas></div>
        <div class="gresult"></div><div class="gouthint">Scroll to zoom, drag to move · <button class="btn small gfit">Fit</button></div></div>
    </div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  $('.grot').value = opt.rot;
  $('.gmap').textContent = ctx.mapName || '';
  $('.gmapname').textContent = ctx.mapName || '';
  const cv = $('.gview'), co = $('.gout'), res = $('.gresult'), note = $('.gnote');
  const dpr = window.devicePixelRatio || 1;

  let mode = null, spot = null, angle = 0, guess = null, rounds = 0, total = 0, log = [];
  let size = 3, hints = 0, t0 = 0, done = false, raf = 0, fogOn = true;
  let rng = Math.random, seedUsed = '', seedTyped = false, seedDay = '';

  // ---- mode picker
  // a spot out in space close to the hull, for the Random training card
  function spaceSpot() {
    for (let tries = 0; tries < 400; tries++) {
      const t = tiles[Math.floor(Math.random() * tiles.length)];
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 3;
      const x = Math.round(t.x + Math.cos(a) * r), y = Math.round(t.y + Math.sin(a) * r);
      const i = idx(x, y);
      if (x < bx0 || y < by0 || x >= bx1 || y >= by1 || !outside[i] || floorName.has(tileKey(x, y))) continue;
      return { x, y };
    }
    return null;
  }
  function showStart() {
    mode = null; cancelAnimationFrame(raf);
    if (starImg && !starImg.complete) starImg.addEventListener('load', () => { if (!mode) showStart(); }, { once: true });
    el.classList.remove('ended');
    el.classList.add('starting');
    const box = $('.gmodes');
    box.innerHTML = '';
    for (const [id, m] of Object.entries(MODES)) {
      const n = pools[id].length;
      const b = document.createElement('button');
      b.className = 'gmodebtn';
      b.disabled = !n;
      b.innerHTML = `<canvas class="gdemo"></canvas><b>${m.name}</b><span>${m.desc}</span><em>${n ? n + ' possible spots · starts ' + opt.sizes[id] + '×' + opt.sizes[id] : 'none on this map'}</em>`;
      b.onclick = () => startMode(id);
      box.appendChild(b);
      if (n) {                                // a sample of what guessing in this mode looks like
        const dc = b.querySelector('canvas');
        dc.width = dc.height = Math.round(200 * dpr);
        const t = id === 'training' ? spaceSpot() || pools[id][0] : pools[id][Math.floor(Math.random() * n)];
        try { renderSpot(dc, t, opt.sizes[id], 0, true); } catch (e) { /* ignore */ }
      } else b.querySelector('canvas').remove();
    }
  }
  function startMode(id) {
    mode = id; opt.mode = id;
    opt.seed = $('.gseed').value.trim(); save(opt);
    seedTyped = !!opt.seed;
    seedUsed = opt.seed || randomSeed();
    seedDay = londonDay();
    rng = mulberry32(hashStr(`${seedUsed}|${seedDay}|${ctx.mapName || ''}|${grid}|${id}`));
    rounds = 0; total = 0; log = []; showScore();
    oz = 1; opx = 0; opy = 0;
    el.classList.remove('starting', 'ended');
    el.classList.toggle('training', id === 'training');
    $('.gmode').textContent = '· ' + MODES[id].name;
    $('.gsize').value = opt.sizes.training;
    newSpot();
    sizeAll();
  }

  // ---- outline of the station (fixed, north up)
  const ox0 = bx0 + 1, oy1 = by1 - 1, oxw = BW - 2, oyh = BH - 2;
  let ow = 0, oh = 0, os = 1, oz = 1, opx = 0, opy = 0;   // fit scale, then zoom and pan of the outline
  function sizeAll() {
    const body = $('.gbody').getBoundingClientRect();
    if (!body.width) return;
    const side = Math.max(200, Math.min(body.width / 2 - 24, body.height - 40));
    cv.style.width = cv.style.height = side + 'px';
    cv.width = cv.height = Math.round(side * dpr);
    const os0 = os;
    os = Math.min((body.width / 2 - 24) / oxw, (body.height - 70) / oyh);
    ow = Math.round(oxw * os); oh = Math.round(oyh * os);
    if (os0 > 0) { opx *= os / os0; opy *= os / os0; }   // keep the zoom and position when the window changes
    co.style.width = ow + 'px'; co.style.height = oh + 'px';
    co.width = Math.round(ow * dpr); co.height = Math.round(oh * dpr);
    drawView(); drawOutline();
  }
  const toOut = (x, y) => [(x - ox0) * os * oz + opx, (oy1 - y) * os * oz + opy];
  const fromOut = (sx, sy) => [(sx - opx) / (os * oz) + ox0, oy1 - (sy - opy) / (os * oz)];
  // floor grey, walls/windows light, doors in between
  const outColor = (k, name) => opt.walls && doors.has(k) ? '#6d7787' : opt.walls && struct.has(k) ? '#9aa6b8'
    : isLattice(name) ? '#262c35' : '#424b58';
  // thin glass as a quarter-tile strip on its edge
  function drawThin(g, at, tsz) {
    const w = tsz / 4;
    for (const [k, list] of thin) {
      const [sx, sy] = at(tileX(k), tileY(k) + 1);
      for (const [dx, dy, isDoor, corner] of list) {
        g.fillStyle = isDoor ? '#6d7787' : '#9aa6b8';
        if (corner) { g.fillRect(dx > 0 ? sx + tsz - w : sx, dy > 0 ? sy : sy + tsz - w, w, w); continue; }
        if (dy < 0) g.fillRect(sx, sy + tsz - w, tsz, w);
        else if (dy > 0) g.fillRect(sx, sy, tsz, w);
        else if (dx > 0) g.fillRect(sx + tsz - w, sy, w, tsz);
        else g.fillRect(sx, sy, w, tsz);
      }
    }
  }
  // small picture of the station around the round, zoomed so the guess and the real spot sit near
  // the edges (at least 8 tiles across), drawn from the map itself, north up
  function miniMap(r, side) {
    const c = document.createElement('canvas');
    c.width = c.height = side * dpr;
    const g = c.getContext('2d');
    const sx0 = r.spot.x + 0.5, sy0 = r.spot.y + 0.5;
    const gx0 = r.guess ? r.guess[0] : sx0, gy0 = r.guess ? r.guess[1] : sy0;
    const span = Math.max(8, Math.abs(gx0 - sx0) * 1.18, Math.abs(gy0 - sy0) * 1.18, r.guess ? 0 : 20);
    const cxm = (sx0 + gx0) / 2, cym = (sy0 + gy0) / 2, sc = side / span;
    const at = (x, y) => [side / 2 + (x - cxm) * sc, side / 2 - (y - cym) * sc];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, side, side);
    R.setViewRot(0);
    g.save();
    g.translate(side / 2, side / 2); g.scale(sc, -sc); g.translate(-cxm, -cym);
    g.imageSmoothingEnabled = sc < PX / 2;
    const h = span / 2 + 1;
    for (let cy = Math.floor((cym - h) / CHUNK); cy <= Math.floor((cym + h) / CHUNK); cy++)
      for (let cx = Math.floor((cxm - h) / CHUNK); cx <= Math.floor((cxm + h) / CHUNK); cx++) {
        const ch = gr.chunks.get(cx + ',' + cy);
        if (!ch) continue;
        if (!ch.canvas) R.renderChunk(gr, ch);
        g.save();
        g.translate(cx * CHUNK, (cy + 1) * CHUNK);
        g.scale(1 / PX, -1 / PX);
        g.drawImage(ch.canvas, 0, 0);
        g.restore();
      }
    g.restore();
    const [ax, ay] = at(sx0, sy0);
    if (r.guess) {
      const [gx, gy] = at(gx0, gy0);
      g.lineCap = 'round';
      g.strokeStyle = '#000'; g.lineWidth = 4.5;   // thin black edge around the line
      g.beginPath(); g.moveTo(gx, gy); g.lineTo(ax, ay); g.stroke();
      const grad = g.createLinearGradient(gx, gy, ax, ay);
      grad.addColorStop(0, '#ff5c8a'); grad.addColorStop(1, '#7bd88f');
      g.strokeStyle = grad; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(gx, gy); g.lineTo(ax, ay); g.stroke();
      mdot(g, gx, gy, '#ff5c8a');
    }
    mdot(g, ax, ay, '#7bd88f');
    c.style.width = c.style.height = side + 'px';
    return c;
  }
  const mdot = (g, x, y, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 2; g.stroke(); };
  function drawOutline() {
    const g = co.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ow, oh);
    for (const t of tiles) {
      const k = tileKey(t.x, t.y);
      g.fillStyle = outColor(k, t.name);
      const [x, y] = toOut(t.x, t.y + 1);
      g.fillRect(x, y, os * oz + 0.3, os * oz + 0.3);
    }
    if (opt.walls) for (const k of struct) if (!floorName.has(k)) {
      const [sx, sy] = toOut(tileX(k), tileY(k) + 1);
      g.fillStyle = outColor(k);
      g.fillRect(sx, sy, os * oz + 0.3, os * oz + 0.3);
    }
    if (opt.walls) drawThin(g, toOut, os * oz);
    if (localStorage.getItem('ss14mv.guessDebug')) {   // shows where each kind of spot can be
      for (const [id, c] of [['photo', 'rgba(123,216,143,.8)'], ['maints', 'rgba(242,184,75,.8)']]) {
        g.fillStyle = c;
        for (const t of pools[id]) { const [x, y] = toOut(t.x, t.y + 1); g.fillRect(x, y, os * oz, os * oz); }
      }
    }
    if (guess && spot) {
      const [ax, ay] = toOut(spot.x + 0.5, spot.y + 0.5);
      if (Array.isArray(guess)) {
        const [gx, gy] = toOut(guess[0], guess[1]);
        g.strokeStyle = '#fff'; g.setLineDash([5, 4]); g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(gx, gy); g.lineTo(ax, ay); g.stroke(); g.setLineDash([]);
        dot(g, gx, gy, '#ff5c8a');
      }
      const half = size / 2;
      g.strokeStyle = '#7bd88f'; g.lineWidth = 2;
      const [rx, ry] = toOut(spot.x + 0.5 - half, spot.y + 0.5 + half);
      g.strokeRect(rx, ry, size * os * oz, size * os * oz);
      dot(g, ax, ay, '#7bd88f');
    }
  }
  const dot = (g, x, y, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); };

  // ---- the view
  function drawView() {
    if (!spot || !cv.width) return;
    renderSpot(cv, spot, size, angle, fogOn);
    note.textContent = `${size}×${size} tiles · ` + (opt.rot === 'none' ? 'north is up' : 'the view may be turned')
      + (fogOn ? '' : ' · no field of view');
  }
  // the view from a spot: map, stars where there is space, shadows where it can't see
  function renderSpot(cv, spot, n, angle, fog) {
    R.setViewRot(angle);                      // sprites drawn as seen from that direction
    const g = cv.getContext('2d'), S = cv.width, pt = S / n;
    const px = spot.x + 0.5, py = spot.y + 0.5;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    if (starImg && starImg.complete && starImg.naturalWidth) {   // space looks like space
      g.save();
      g.translate(-((px * 9) % 512), (py * 9) % 512);
      g.fillStyle = g.createPattern(starImg, 'repeat');
      g.fillRect(-512, -512, S + 1024, S + 1024);
      g.restore();
    }
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
    if (fog) {
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
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = 'rgba(255,255,255,.7)';
    g.lineWidth = Math.max(1, dpr);
    const r = Math.max(4, pt * 0.12);
    g.beginPath(); g.moveTo(S / 2 - r, S / 2); g.lineTo(S / 2 + r, S / 2); g.moveTo(S / 2, S / 2 - r); g.lineTo(S / 2, S / 2 + r); g.stroke();
  }

  // ---- points and timer
  const timed = () => mode !== 'training';
  function available(now) {
    if (!timed()) return START;
    const t = (now - t0) / 1000 - GRACE, T = Math.max(30, opt.minutes * 60);
    const u = Math.min(1, Math.max(0, t / T));
    return START * (1 - u) * (1 - u) * Math.pow(0.75, hints);   // drains fast at first, slower near the end
  }
  function tick() {
    if (!mode || done) return;
    const now = performance.now();
    if (timed()) {
      const left = Math.max(0, Math.max(30, opt.minutes * 60) + GRACE - (now - t0) / 1000);
      const mm = Math.floor(left / 60), ss = Math.floor(left % 60);
      $('.gtimer').innerHTML = `⏱ ${mm}:${String(ss).padStart(2, '0')} · <b>${Math.round(available(now))}</b> pts`;
      if (left <= 0) { finish('timeout'); return; }
    } else $('.gtimer').textContent = '';
    raf = requestAnimationFrame(tick);
  }
  function showScore() {
    $('.gscore').textContent = !mode ? '' : mode === 'training' ? (rounds ? `${total} pts · ${rounds} rounds` : '')
      : `Round ${Math.min(ROUNDS, rounds + (done ? 0 : 1))}/${ROUNDS} · ${total} pts`;
  }

  // a spot not near the earlier ones of this game; maints: an area first (gently weighted by size), then a tile in it
  // recent spots on this map, kept across games (and reloads) so the same places don't come back
  const histKey = 'ss14mv.guessSeen.' + (ctx.mapName || '') + '.' + grid;
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(histKey)) || []; } catch (e) { hist = []; }
  const remember = (t) => {
    hist.push([t.x, t.y]); if (hist.length > 48) hist = hist.slice(-48);
    try { localStorage.setItem(histKey, JSON.stringify(hist)); } catch (e) { /* ignore */ }
  };
  function pickSpot(pool) {
    const nearGame = (t) => log.some(r => Math.hypot(r.spot.x - t.x, r.spot.y - t.y) < 8);
    const nearHist = (t) => !seedTyped && hist.some(([x, y]) => Math.hypot(x - t.x, y - t.y) < 8);
    const areas = mode === 'maints' ? [...byRoom.values()] : null;
    const wt = (l) => Math.pow(l.length, 0.7);          // big areas a bit more often, small ones not favoured
    const wsum = areas ? areas.reduce((a, l) => a + wt(l), 0) : 0;
    const draw = () => {
      if (areas && areas.length) {
        let r = rng() * wsum, l = areas[0];
        for (const a of areas) { r -= wt(a); if (r <= 0) { l = a; break; } }
        return l[Math.floor(rng() * l.length)];
      }
      return pool[Math.floor(rng() * pool.length)];
    };
    let fallback = null;
    for (let tries = 0; tries < 400; tries++) {
      const t = draw();
      if (nearGame(t)) continue;
      if (!fallback) fallback = t;
      if (!nearHist(t)) return t;
    }
    return fallback || draw();                // small maps: at least not near this game's spots
  }
  function newSpot() {
    const pool = pools[mode];
    if (!pool || !pool.length) { showStart(); return; }
    spot = pickSpot(pool);
    remember(spot);
    angle = opt.rot === '90' ? Math.floor(rng() * 4) * Math.PI / 2 : 0;
    guess = null; done = false; hints = 0; fogOn = true;
    $('.gfoghint').disabled = false;
    size = opt.sizes[mode] || 3;
    res.textContent = 'Click the station where you think this is.';
    $('.ghint').disabled = false;
    t0 = performance.now();
    drawView(); drawOutline();
    showScore();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  }
  function finish(g) {
    if (done) return;
    done = true; guess = g; cancelAnimationFrame(raf);
    $('.ghint').disabled = true; $('.gfoghint').disabled = true;
    rounds++;
    const last = rounds >= ROUNDS && mode !== 'training';
    const nextBtn = `<button class="btn small primary gnext">${last ? 'See results' : 'Next'}</button>`;
    // keep a small copy of the view for the end screen
    const shot = document.createElement('canvas');
    shot.width = shot.height = 160;
    shot.getContext('2d').drawImage(cv, 0, 0, 160, 160);
    const rec = { spot, guess: Array.isArray(g) ? g : null, size, hints: (size - (opt.sizes[mode] || 3)) / 2 + (fogOn ? 0 : 1), pts: 0, d: null, shot, why: Array.isArray(g) ? '' : g };
    log.push(rec);
    if (!Array.isArray(g)) {
      res.innerHTML = `<b>${g === 'timeout' ? "Time's up" : 'Skipped'}</b> · 0 points ${nextBtn}`;
      $('.gtimer').textContent = '';
    } else {
      const pts0 = available(performance.now());
      const d = Math.hypot(g[0] - (spot.x + 0.5), g[1] - (spot.y + 0.5));
      const scale = Math.max(6, Math.hypot(oxw, oyh) / 15);
      const close = Math.exp(-Math.max(0, d - 0.7) / scale);
      const pts = Math.round(pts0 * close);
      total += pts;
      rec.pts = pts; rec.d = d;
      res.innerHTML = `${spot.item ? '<span class="hint">' + esc(spot.item) + ' ·</span> ' : ''}<b>${d < 1 ? 'Spot on!' : d.toFixed(1) + ' tiles away'}</b> · ${pts} points
        <span class="hint">(${Math.round(pts0)} left × ${Math.round(close * 100)}% close)</span> ${nextBtn}`;
    }
    res.querySelector('.gnext').onclick = last ? showEnd : newSpot;
    showScore();
    drawOutline();
  }
  function showEnd() {
    cancelAnimationFrame(raf);
    el.classList.add('ended');
    const max = ROUNDS * START;
    const box = $('.gend');
    box.innerHTML = `<h2>${MODES[mode].name}</h2>
      <div class="gtotal"><b>${total}</b> / ${max} points · <b>${(100 * total / max).toFixed(1)}%</b></div>
      <div class="gsettings">${esc(settingsText())}</div>
      <div class="grounds"></div>
      <div class="row gap"><button class="btn primary gagain">Play again</button><button class="btn gcopy">Copy end screen</button><button class="btn gmodes2">Modes</button></div>`;
    const list = box.querySelector('.grounds');
    log.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'ground';
      card.innerHTML = `<div class="gpics"></div><div class="gcap"><b>${i + 1}.</b> ${r.guess ? (r.d < 1 ? 'spot on' : r.d.toFixed(1) + ' tiles') : (r.why === 'timeout' ? "time's up" : 'skipped')} · <b>${r.pts}</b></div>`;
      const pics = card.querySelector('.gpics');
      r.shot.className = 'gshot';
      pics.appendChild(r.shot);
      pics.appendChild(miniMap(r, 160));
      list.appendChild(card);
    });
    box.querySelector('.gagain').onclick = () => startMode(mode);
    box.querySelector('.gcopy').onclick = (e) => copyEnd(e.target);
    box.querySelector('.gmodes2').onclick = showStart;
  }
  // outline: wheel zooms at the cursor, drag pans, a click without dragging is the guess
  let drag = null;
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function settingsText() {
    const hintsUsed = log.reduce((a, r) => a + (r.hints || 0), 0);
    return [ctx.mapName, `seed ${seedUsed} (${seedDay})`, `start ${opt.sizes[mode]}×${opt.sizes[mode]}`, mode === 'training' ? 'no timer' : `timer ${opt.minutes} min`,
      `rotation ${opt.rot === 'none' ? 'north up' : 'quarter turns'}`, `${hintsUsed} hint${hintsUsed === 1 ? '' : 's'} used`].filter(Boolean).join(' · ');
  }
  // the end screen as one picture, copied to the clipboard (or downloaded if that is not allowed)
  async function copyEnd(btn) {
    const cols = 3, cw = 360, chh = 200, pad = 16, head = 96;
    const rows = Math.ceil(log.length / cols);
    const c = document.createElement('canvas');
    c.width = pad + cols * (cw + pad); c.height = head + rows * (chh + pad) + pad;
    const g = c.getContext('2d');
    g.fillStyle = '#06080d'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#f2b84b'; g.font = '600 20px system-ui, sans-serif';
    g.fillText(`Station Guesser · ${MODES[mode].name}`, pad, 32);
    g.fillStyle = '#e6ebf2'; g.font = '600 17px system-ui, sans-serif';
    const max = ROUNDS * START;
    g.fillText(`${total} / ${max} points · ${(100 * total / max).toFixed(1)}%`, pad, 58);
    g.fillStyle = '#8b96a7'; g.font = '13px system-ui, sans-serif';
    g.fillText(settingsText(), pad, 80);
    log.forEach((r, i) => {
      const x = pad + (i % cols) * (cw + pad), y = head + Math.floor(i / cols) * (chh + pad);
      g.fillStyle = '#11161e'; g.fillRect(x, y, cw, chh);
      g.drawImage(r.shot, x + 12, y + 10, 160, 160);
      g.drawImage(miniMap(r, 160), x + 188, y + 10, 160, 160);
      g.fillStyle = '#aab4c3'; g.font = '13px system-ui, sans-serif';
      g.fillText(`${i + 1}. ${r.guess ? (r.d < 1 ? 'spot on' : r.d.toFixed(1) + ' tiles') : (r.why === 'timeout' ? "time's up" : 'skipped')} · ${r.pts} pts`, x + 12, y + 190);
    });
    const blob = await new Promise(res2 => c.toBlob(res2, 'image/png'));
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      btn.textContent = 'Copied!';
    } catch (e) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'station-guesser.png'; a.click();
      btn.textContent = 'Saved as a picture';
    }
    setTimeout(() => { btn.textContent = 'Copy end screen'; }, 2500);
  }
  co.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = co.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const [wx, wy] = fromOut(mx, my);
    oz = Math.max(1, Math.min(40, oz * Math.pow(1.0015, -e.deltaY)));
    if (oz === 1) { opx = 0; opy = 0; }
    else { const [sx, sy] = toOut(wx, wy); opx += mx - sx; opy += my - sy; }
    drawOutline();
  }, { passive: false });
  co.addEventListener('pointerdown', (e) => {
    if (e.button === 1) e.preventDefault();   // middle button: only moves the map
    co.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, px: opx, py: opy, moved: false, button: e.button };
  });
  co.addEventListener('auxclick', (e) => e.preventDefault());
  co.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { opx = drag.px + dx; opy = drag.py + dy; co.style.cursor = 'grabbing'; drawOutline(); }
  });
  co.addEventListener('pointerup', (e) => {
    const d = drag; drag = null; co.style.cursor = '';
    if (!d || d.moved || d.button !== 0 || !spot || done || !mode) return;   // only a plain left click guesses
    const r = co.getBoundingClientRect();
    finish(fromOut(e.clientX - r.left, e.clientY - r.top));
  });
  $('.gfit').onclick = () => { oz = 1; opx = 0; opy = 0; drawOutline(); };

  // ---- controls
  $('.ghint').onclick = () => {
    if (done || size >= 61) return;
    size += 2;
    if (timed()) hints++;
    drawView();
  };
  $('.gfoghint').onclick = () => {
    if (done || !fogOn) return;
    fogOn = false;
    if (timed()) hints++;
    $('.gfoghint').disabled = true;
    drawView();
  };
  $('.gskip').onclick = () => { if (!done && spot && mode) finish('skip'); };
  $('.gmenu').onclick = showStart;
  $('.gsize').onchange = (e) => { opt.sizes.training = Math.max(1, Math.min(61, Math.round(+e.target.value) || 5)); e.target.value = opt.sizes.training; save(opt); if (mode === 'training') { size = opt.sizes.training; drawView(); } };



  $('.gwalls').onchange = (e) => { opt.walls = e.target.checked; save(opt); drawOutline(); };

  $('.grot').onchange = (e) => { opt.rot = e.target.value; save(opt); };
  $('.grandseed').onclick = () => { $('.gseed').value = randomSeed(); };
  const close = () => {
    cancelAnimationFrame(raf);
    el.remove(); if (ctx.onClose) ctx.onClose();
    window.removeEventListener('resize', sizeAll); window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.target.matches && e.target.matches('input, select')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if ((e.key === 'Enter' || e.key === ' ') && done && mode && !el.classList.contains('ended')) { e.preventDefault(); e.stopPropagation(); res.querySelector('.gnext') && res.querySelector('.gnext').click(); }
    else if (e.key.toLowerCase() === 'h' && mode && !done) { e.stopPropagation(); $('.ghint').click(); }
    else if (e.key.toLowerCase() === 'f' && mode && !done) { e.stopPropagation(); $('.gfoghint').click(); }
    else e.stopPropagation();                 // keep the map's shortcuts out of the game
  };
  $('.gclose').onclick = close;
  window.addEventListener('resize', sizeAll);
  window.addEventListener('keydown', onKey, true);
  showStart();
}
