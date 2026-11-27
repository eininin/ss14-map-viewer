// Levels editor: paint a height level onto tiles, mark cuts and stairs, check the rules, and save it all to
// a sidecar file <mapname>.levels.json for the Blender importer. The map .yml is never changed.
//
// Coordinates: grid entity uid from the map file; tile x, y are the grid's local tile indices
// (chunk index * 16 + position in the chunk, y up), the same keys as the Area selection ("x,y").
//
// Inside, every tile is looked at as four quarters (SW, SE, NW, NE). A plain tile has its level in all four;
// a middle-cut tile takes, for each half, the level of the tile on that side; stairs are their own thing.
// The touching rules are then checked quarter against quarter across tile edges.

export const LEVEL_STEP = 0.75, LEVEL_MIN = -3, LEVEL_MAX = 3, MAX_STEP = 3;
export const LEVELS = [-3, -2.25, -1.5, -0.75, 0, 0.75, 1.5, 2.25, 3];
const COLORS = {
  '-3': '#3346ff', '-2.25': '#3f73ff', '-1.5': '#3fa0ff', '-0.75': '#4fd0f0',
  '0': '#9aa3ad', '0.75': '#ffe066', '1.5': '#ffae42', '2.25': '#ff7038', '3': '#ff3366',
};
const DIRS = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
const CW = { N: 'E', E: 'S', S: 'W', W: 'N' };
// A cut tile is a set of arms from the tile centre to the middle of its edges, written as letters in the
// order n, s, w, e: "ns" (north–south line), "we" (west–east line), "ne"/"nw"/"se"/"sw" (corners),
// "nsw"/"nse"/"nwe"/"swe" (T shapes), "nswe" (cross). An arm N separates the NW and NE quarters, and so on.
const ARM_ORDER = ['n', 's', 'w', 'e'];
export const canonArms = (str) => { const set = new Set(String(str || '').toLowerCase()); return ARM_ORDER.filter(a => set.has(a)).join(''); };
const armsOf = (str) => new Set(String(str || ''));
const ARM_SEP = { n: [2, 3], e: [3, 1], s: [1, 0], w: [0, 2] };   // the two quarters an arm separates
const SNAP = (v) => Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(v / LEVEL_STEP) * LEVEL_STEP)) + 0;
const fmt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + String(Number(Math.abs(v).toFixed(2))) + ' m';
const key = (x, y) => x + ',' + y;
const unkey = (k) => { const i = k.indexOf(','); return [+k.slice(0, i), +k.slice(i + 1)]; };
export const levelColor = (v) => COLORS[String(SNAP(v))] || '#ffffff';
export function stairKind(step) {
  const d = Math.abs(step);
  if (Math.abs(d - 0.75) < 1e-6) return { label: '0.75', name: 'small stairs' };
  if (Math.abs(d - 1.5) < 1e-6) return { label: '1.5', name: 'steep stairs' };
  return { label: 'ladder', name: 'ladder' };
}

async function sha1(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- the data
class GridLevels {
  constructor() { this.levels = new Map(); this.cuts = new Map(); this.edges = new Set(); this.stairs = new Map(); }
  get empty() { return !this.levels.size && !this.cuts.size && !this.edges.size && !this.stairs.size; }
}
// an edge is stored once, as E or N of a tile
function edgeKey(x, y, side) {
  if (side === 'W') { x -= 1; side = 'E'; }
  if (side === 'S') { y -= 1; side = 'N'; }
  return x + ',' + y + ',' + side;
}

export class LevelsDoc {
  constructor() { this.grids = new Map(); this.undoStack = []; this.redoStack = []; }
  g(uid) { if (!this.grids.has(uid)) this.grids.set(uid, new GridLevels()); return this.grids.get(uid); }
  serialize() {
    const out = {};
    for (const [uid, d] of this.grids) {
      if (d.empty) continue;
      out[uid] = { levels: [...d.levels], cuts: [...d.cuts], edges: [...d.edges], stairs: [...d.stairs] };
    }
    return out;
  }
  restore(o) {
    this.grids = new Map();
    for (const uid of Object.keys(o || {})) {
      const d = this.g(uid), s = o[uid];
      d.levels = new Map(s.levels || []); d.cuts = new Map(s.cuts || []);
      d.edges = new Set(s.edges || []); d.stairs = new Map(s.stairs || []);
    }
  }
  snapshot() {
    this.undoStack.push(JSON.stringify(this.serialize()));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(JSON.stringify(this.serialize())); this.restore(JSON.parse(this.undoStack.pop())); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(JSON.stringify(this.serialize())); this.restore(JSON.parse(this.redoStack.pop())); return true; }
  get empty() { for (const d of this.grids.values()) if (!d.empty) return false; return true; }

  // the sidecar file
  toFile(mapName, mapSha1) {
    const grids = {};
    const sortKeys = (m) => [...m.entries()].sort((a, b) => { const [ax, ay] = unkey(a[0]), [bx, by] = unkey(b[0]); return ay - by || ax - bx; });
    for (const [uid, d] of this.grids) {
      if (d.empty) continue;
      const levels = {}, cuts = {}, stairs = {};
      for (const [k, v] of sortKeys(d.levels)) if (v !== 0) levels[k] = v;
      for (const [k, v] of sortKeys(d.cuts)) cuts[k] = v;
      for (const [k, v] of sortKeys(d.stairs)) stairs[k] = v;
      const edges = [...d.edges].map(e => { const p = e.split(','); return { x: +p[0], y: +p[1], side: p[2] }; })
        .sort((a, b) => a.y - b.y || a.x - b.x || (a.side < b.side ? -1 : 1));
      grids[uid] = { levels, cuts, edges, stairs };
    }
    return { format: 'ss14-levels', version: 1, map: mapName, map_sha1: mapSha1 || '', grids };
  }
  fromFile(j) {
    if (!j || j.format !== 'ss14-levels') throw new Error('this is not an ss14-levels file');
    if (j.version !== 1) throw new Error('unknown version ' + j.version);
    this.grids = new Map();
    for (const uid of Object.keys(j.grids || {})) {
      const s = j.grids[uid], d = this.g(String(uid));
      for (const [k, v] of Object.entries(s.levels || {})) { const n = SNAP(+v); if (n !== 0) d.levels.set(k, n); }
      for (const [k, v] of Object.entries(s.cuts || {})) { const a = canonArms(v); if (a.length >= 2 && a.length === String(v).length) d.cuts.set(k, a); }
      for (const e of (s.edges || [])) if (DIRS[e.side]) d.edges.add(edgeKey(+e.x, +e.y, e.side));
      for (const [k, v] of Object.entries(s.stairs || {})) if (DIRS[v]) d.stairs.set(k, v);
    }
  }
}

// ---------------------------------------------------------------- checking
// tiles: Set of "x,y" with a floor (any tile) on this grid. Returns quarters, warnings, stubs, stair info.
export function analyse(d, tiles, doors = new Set()) {
  const exists = (x, y) => tiles.has(key(x, y)) || d.levels.has(key(x, y)) || d.cuts.has(key(x, y)) || d.stairs.has(key(x, y));
  // quarter i: 0 SW, 1 SE, 2 NW, 3 NE. Value: a level, null (no tile / unknown), or 'S' (stairs)
  const base = (x, y, i) => {
    const k = key(x, y);
    if (!exists(x, y)) return null;
    if (d.stairs.has(k)) return 'S';
    return d.levels.get(k) || 0;
  };
  // cut tiles: each region between the arms takes the level of the neighbours on its outer sides
  // (other cut tiles resolve together, a few passes)
  const OUTER = [[[0, -1, 2], [-1, 0, 1]], [[0, -1, 3], [1, 0, 0]], [[0, 1, 0], [-1, 0, 3]], [[0, 1, 1], [1, 0, 2]]];
  const cutRegions = new Map(), cutQ = new Map();
  for (const [k, arms] of d.cuts) {
    const A = armsOf(arms), parent = [0, 1, 2, 3];
    const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (const a of ['n', 'e', 's', 'w']) if (!A.has(a)) { const [p, q] = ARM_SEP[a]; parent[find(p)] = find(q); }
    const groups = new Map();
    for (let i = 0; i < 4; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    cutRegions.set(k, [...groups.values()]);
    cutQ.set(k, [null, null, null, null]);
  }
  const quarter = (x, y, i) => { const k = key(x, y); return cutQ.has(k) ? cutQ.get(k)[i] : base(x, y, i); };
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const [k, regions] of cutRegions) {
      const [x, y] = unkey(k), q = cutQ.get(k);
      for (const reg of regions) {
        const count = new Map();
        for (const i of reg) for (const [dx, dy, j] of OUTER[i]) {
          const v = quarter(x + dx, y + dy, j);
          if (typeof v === 'number') count.set(v, (count.get(v) || 0) + 1);
        }
        let best = null, bn = 0;
        for (const [v, n] of count) if (n > bn) { best = v; bn = n; }
        for (const i of reg) if (q[i] !== best) { q[i] = best; moved = true; }
      }
    }
    if (!moved) break;
  }
  const num = (v) => typeof v === 'number';
  const warnings = [];
  const warn = (kind, x, y, msg) => warnings.push({ kind, x, y, msg });
  // the tiles worth looking at: everything marked and its neighbours
  const marked = new Set([...d.levels.keys(), ...d.cuts.keys(), ...d.stairs.keys()]);
  for (const e of d.edges) { const p = e.split(','); marked.add(p[0] + ',' + p[1]); const [dx, dy] = DIRS[p[2]]; marked.add(key(+p[0] + dx, +p[1] + dy)); }
  const look = new Set();
  for (const k of marked) { const [x, y] = unkey(k); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) look.add(key(x + dx, y + dy)); }

  // 1. tile edges: different levels touching without a cut
  const errEdges = new Set();
  for (const k of look) {
    const [x, y] = unkey(k);
    for (const side of ['E', 'N']) {
      const [dx, dy] = DIRS[side], bx = x + dx, by = y + dy;
      if (!exists(x, y) || !exists(bx, by)) continue;
      if (d.edges.has(edgeKey(x, y, side))) continue;
      const pairs = side === 'E' ? [[1, 0], [3, 2]] : [[2, 0], [3, 1]];
      for (const [qa, qb] of pairs) {
        const a = quarter(x, y, qa), b = quarter(bx, by, qb);
        if (!num(a) || !num(b) || a === b) continue;
        errEdges.add(edgeKey(x, y, side));
        warn('error', x + 0.5 + dx / 2, y + 0.5 + dy / 2, `${fmt(a)} and ${fmt(b)} touch with no cut between them`);
        break;
      }
    }
  }

  // 2. middle cuts: each arm is a cut line from the centre to an edge
  const stubs = [], cutLines = [];
  const ARM_END = { n: [0.5, 1], s: [0.5, 0], w: [0, 0.5], e: [1, 0.5] };
  for (const [k, arms] of d.cuts) {
    const [x, y] = unkey(k);
    const q = cutQ.get(k);
    const lvls = new Set(q.filter(num));
    for (const a of arms) {
      const [ex, ey] = ARM_END[a];
      cutLines.push([x + 0.5, y + 0.5, x + ex, y + ey]);
      const [qa, qb] = ARM_SEP[a].map(i => q[i]);
      if (!num(qa) || !num(qb) || qa === qb) continue;
      if (Math.abs(qa - qb) > MAX_STEP + 1e-9) warn('error', x + 0.5, y + 0.5, `Step of ${Math.abs(qa - qb)} m (more than ${MAX_STEP} m)`);
      // stubs along the arm: bottom on the lower side, top on the higher side, both facing the arm
      // (quarter order: n separates NW|NE = W|E sides; e separates NE|SE = N|S; s: SE|SW = E|W; w: SW|NW = S|N)
      const sides = { n: ['W', 'E'], e: ['N', 'S'], s: ['E', 'W'], w: ['S', 'N'] }[a];
      const mx = x + (0.5 + ex) / 2, my = y + (0.5 + ey) / 2, ax = (a === 'n' || a === 's') ? 'v' : 'h';
      stubs.push({ x: mx, y: my, side: qa < qb ? sides[0] : sides[1], kind: 'bottom', ax, len: 0.3 });
      stubs.push({ x: mx, y: my, side: qa < qb ? sides[1] : sides[0], kind: 'top', ax, len: 0.3 });
    }
    if (lvls.size < 2) {
      const lvl = (xx, yy) => { const v = base(xx, yy, 0); return num(v) && !d.cuts.has(key(xx, yy)) ? v : null; };
      const n = lvl(x, y + 1), s2 = lvl(x, y - 1), w = lvl(x - 1, y), e = lvl(x + 1, y);
      const wrong = arms === 'ns' ? (num(n) && num(s2) && n !== s2) : arms === 'we' ? (num(w) && num(e) && w !== e) : false;
      warn('error', x + 0.5, y + 0.5, wrong
        ? `Cut line runs the wrong way: the level changes ${arms === 'ns' ? 'south to north (use a west–east line)' : 'west to east (use a north–south line)'}`
        : 'Cut tile without two different levels around it');
    }
  }

  // 3. edge cuts
  for (const e of d.edges) {
    const p = e.split(','), x = +p[0], y = +p[1], side = p[2];
    const [dx, dy] = DIRS[side], bx = x + dx, by = y + dy;
    cutLines.push(side === 'E' ? [x + 1, y, x + 1, y + 1] : [x, y + 1, x + 1, y + 1]);
    const a = side === 'E' ? quarter(x, y, 1) : quarter(x, y, 2), b = side === 'E' ? quarter(bx, by, 0) : quarter(bx, by, 0);
    if (!num(a) || !num(b)) continue;
    if (a === b) { warn('check', x + dx / 2 + 0.5, y + dy / 2 + 0.5, 'Edge cut between two tiles at the same level'); continue; }
    if (Math.abs(a - b) > MAX_STEP + 1e-9) warn('error', x + 0.5 + dx / 2, y + 0.5 + dy / 2, `Step of ${Math.abs(a - b)} m (more than ${MAX_STEP} m)`);
    const lowA = a < b;
    // each stub in its own tile next to the edge
    stubs.push({ x: side === 'E' ? x + 1 : x + 0.5, y: side === 'E' ? y + 0.5 : y + 1, side: side === 'E' ? 'W' : 'S', kind: lowA ? 'bottom' : 'top', ax: side === 'E' ? 'v' : 'h' });
    stubs.push({ x: side === 'E' ? x + 1 : x + 0.5, y: side === 'E' ? y + 0.5 : y + 1, side: side === 'E' ? 'E' : 'N', kind: lowA ? 'top' : 'bottom', ax: side === 'E' ? 'v' : 'h' });
  }

  // 4. stairs
  const stairInfo = [];
  for (const [k, dir] of d.stairs) {
    const [x, y] = unkey(k);
    const [dx, dy] = DIRS[dir];
    // the two quarters of a neighbour on its given side
    const sideQ = (nx, ny, side) => ({ N: [2, 3], S: [0, 1], E: [1, 3], W: [0, 2] }[side]).map(i => quarter(nx, ny, i));
    const lowQ = sideQ(x - dx, y - dy, dir);        // the tile in front, its side toward the stairs
    const highQ = sideQ(x + dx, y + dy, OPP[dir]);  // the tile behind
    const one = (q) => (num(q[0]) && q[0] === q[1]) ? q[0] : null;
    const lo = one(lowQ), hi = one(highQ);
    const info = { x, y, dir, lo, hi, kind: null, airlock: doors.has(k) };
    stairInfo.push(info);
    if (lo === null) { warn('error', x + 0.5, y + 0.5, `Stairs: the low side (${OPP[dir]}) isn't one level`); continue; }
    if (hi === null) { warn('error', x + 0.5, y + 0.5, `Stairs: the high side (${dir}) isn't one level`); continue; }
    if (lo === hi) { warn('error', x + 0.5, y + 0.5, `Stairs with both sides at ${fmt(lo)}`); continue; }
    if (hi < lo) { warn('error', x + 0.5, y + 0.5, `Stairs rise ${dir} but the ${dir} side is lower (${fmt(hi)} < ${fmt(lo)})`); continue; }
    if (hi - lo > MAX_STEP + 1e-9) warn('error', x + 0.5, y + 0.5, `Step of ${hi - lo} m (more than ${MAX_STEP} m)`);
    info.kind = stairKind(hi - lo);
  }

  // 5. corners: different levels touching only diagonally
  const corners = new Set();
  for (const k of look) { const [x, y] = unkey(k); corners.add(key(x, y)); corners.add(key(x + 1, y)); corners.add(key(x, y + 1)); corners.add(key(x + 1, y + 1)); }
  for (const k of corners) {
    const [cx, cy] = unkey(k);
    const bl = quarter(cx - 1, cy - 1, 3), br = quarter(cx, cy - 1, 2), tl = quarter(cx - 1, cy, 1), tr = quarter(cx, cy, 0);
    const open = (v) => v === null || v === 'S';
    if (num(bl) && num(tr) && bl !== tr && open(br) && open(tl)) warn('check', cx, cy, `${fmt(bl)} and ${fmt(tr)} touch only at a corner`);
    else if (num(br) && num(tl) && br !== tl && open(bl) && open(tr)) warn('check', cx, cy, `${fmt(br)} and ${fmt(tl)} touch only at a corner`);
  }
  // also a step of more than 3 m between neighbours at different levels without a cut is already an error

  return { quarter, warnings, stubs, cutLines, stairInfo, errEdges };
}

// ---------------------------------------------------------------- the tool
export function createLevels(env) {
  // env: { pane, getScene, getRenderer, getModel, gridLocal, gridWorld, setGridXf, camScale, redraw, jumpTo,
  //        toast, download, mapSource, mapKey, getArea, setTool, isActive, safeName, lsGet, lsSet }
  const doc = new LevelsDoc();
  const ui = { mode: 'paint', level: 1.5, cutDir: 'auto', stairDir: 'auto', brush: 1, show: true, onlyMarks: false };
  let analysis = new Map();       // grid uid -> analyse() result
  let tileSets = { scene: null, map: new Map() };
  let mapSha1 = null, fileNote = '';
  let drag = null, hover = null;

  const tilesOf = (uid) => {
    const scene = env.getScene();
    if (tileSets.scene !== scene) { tileSets = { scene, map: new Map() }; }
    if (!tileSets.map.has(uid)) {
      const s = new Set();
      const list = scene ? (scene.tiles.get(+uid) || scene.tiles.get(uid) || []) : [];
      for (const t of list) s.add(key(t.x, t.y));
      tileSets.map.set(uid, s);
    }
    return tileSets.map.get(uid);
  };

  // tiles with an airlock or other door on them (stairs there are "in an airlock")
  const doorsOf = (uid) => {
    const scene = env.getScene();
    if (tileSets.scene !== scene) tileSets = { scene, map: new Map() };
    const dk = 'doors|' + uid;
    if (!tileSets.map.has(dk)) {
      const s2 = new Set();
      if (scene) for (const it of scene.items) {
        if (it.kind !== 'ent' || String(it.grid) !== String(uid)) continue;
        if (it.cat === 'doors' || (it.info && it.info.door != null)) s2.add(key(Math.floor(it.x), Math.floor(it.y)));
      }
      tileSets.map.set(dk, s2);
    }
    return tileSets.map.get(dk);
  };
  function reanalyse() {
    analysis = new Map();
    for (const [uid, d] of doc.grids) if (!d.empty) analysis.set(uid, analyse(d, tilesOf(uid), doorsOf(uid)));
  }
  function changed() {
    reanalyse();
    try { if (env.mapSource()) env.lsSet('levels.' + env.mapKey(), doc.serialize()); } catch (e) { /* ignore */ }
    renderPane();
    env.redraw();
  }

  // the grid under a world point, and the local tile position there
  function gridAt(wx, wy) {
    const R = env.getRenderer();
    if (!R.grids) return null;
    let best = null;
    for (const gr of R.grids.values()) {
      if (!isFinite(gr.minX)) continue;
      const [lx, ly] = env.gridLocal(gr, wx, wy);
      const inside = lx >= gr.minX && lx <= gr.maxX && ly >= gr.minY && ly <= gr.maxY;
      const has = tilesOf(String(gr.uid)).has(key(Math.floor(lx), Math.floor(ly)));
      if (has) return { gr, uid: String(gr.uid), lx, ly };
      if (inside && !best) best = { gr, uid: String(gr.uid), lx, ly };
    }
    if (best) return best;
    const area = env.getArea();
    const gr = R.grids.get(area && area.grid != null ? area.grid : [...R.grids.keys()][0]);
    if (!gr) return null;
    const [lx, ly] = env.gridLocal(gr, wx, wy);
    return { gr, uid: String(gr.uid), lx, ly };
  }

  // ---- edits
  const neighbourLevel = (d, uid, x, y) => {
    const k = key(x, y);
    if (d.cuts.has(k) || d.stairs.has(k)) return null;
    if (!tilesOf(uid).has(k) && !d.levels.has(k)) return null;
    return d.levels.get(k) || 0;
  };
  function paintTile(d, x, y, v) {
    const k = key(x, y);
    if (v === 0) d.levels.delete(k); else d.levels.set(k, v);
  }
  function paintAt(h) {
    const d = doc.g(h.uid), x0 = Math.floor(h.lx), y0 = Math.floor(h.ly), r = (ui.brush - 1) / 2;
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) paintTile(d, x, y, ui.level);
  }
  // ---- cuts: arms toward the previous and next tile of a drag; arms join neighbouring cut tiles and stairs
  const ARMDIR = { n: [0, 1], s: [0, -1], w: [-1, 0], e: [1, 0] };
  const OPPA = { n: 's', s: 'n', w: 'e', e: 'w' };
  const setArms = (d, k, set) => d.cuts.set(k, canonArms([...set].join('')));
  // arms for a tile on its own: toward neighbouring cut tiles and stairs, else a straight line across
  // the level change
  function autoArms(d, uid, x, y) {
    if (ui.cutDir === 'ns' || ui.cutDir === 'we') return new Set(ui.cutDir);
    const set = new Set();
    for (const a of ['n', 's', 'w', 'e']) {
      const [dx, dy] = ARMDIR[a], nk = key(x + dx, y + dy);
      if (d.stairs.has(nk) || (d.cuts.has(nk) && d.cuts.get(nk).includes(OPPA[a]))) set.add(a);
    }
    if (set.size === 1) { const only = [...set][0]; set.add(OPPA[only]); }
    if (set.size >= 2) return set;
    const w = neighbourLevel(d, uid, x - 1, y), e = neighbourLevel(d, uid, x + 1, y);
    const so = neighbourLevel(d, uid, x, y - 1), n = neighbourLevel(d, uid, x, y + 1);
    if (w !== null && e !== null && w !== e) return new Set('ns');
    if (so !== null && n !== null && so !== n) return new Set('we');
    return new Set((so !== null && n !== null && (w === null || e === null)) ? 'we' : 'ns');
  }
  // a cut tile's arms that point at a cut tile without the matching arm: give it that arm (T or cross)
  function joinNeighbours(d, k) {
    const [x, y] = unkey(k);
    for (const a of (d.cuts.get(k) || '')) {
      const [dx, dy] = ARMDIR[a], nk = key(x + dx, y + dy);
      if (d.cuts.has(nk) && !d.cuts.get(nk).includes(OPPA[a])) setArms(d, nk, new Set(d.cuts.get(nk) + OPPA[a]));
    }
  }
  function cutStart(h) {
    const d = doc.g(h.uid), x = Math.floor(h.lx), y = Math.floor(h.ly), k = key(x, y);
    d.stairs.delete(k);
    const existed = d.cuts.has(k);
    drag = { kind: 'cut', uid: h.uid, last: k, start: k, existed, moved: false, before: new Map(), prov: new Map(), h0: h };
    drag.before.set(k, existed ? d.cuts.get(k) : null);
    if (!existed) setArms(d, k, autoArms(d, h.uid, x, y));
  }
  function cutStep(toK) {
    const d = doc.g(drag.uid), [px, py] = unkey(drag.last), [tx, ty] = unkey(toK);
    const a = tx > px ? 'e' : tx < px ? 'w' : ty > py ? 'n' : 's';
    drag.moved = true;
    // the tile we leave: its arm toward the new tile; a straight guess made for it on the way in goes
    const prevArms = armsOf(d.cuts.get(drag.last));
    const before = drag.before.get(drag.last);
    if (drag.last === drag.start && !drag.existed) { prevArms.clear(); }
    else if (drag.prov.has(drag.last)) { const pa = drag.prov.get(drag.last); if (!(before && before.includes(pa))) prevArms.delete(pa); }
    drag.prov.delete(drag.last);
    if (before) for (const c of before) prevArms.add(c);
    prevArms.add(a);
    if (drag.last === drag.start && !drag.existed && prevArms.size < 2) prevArms.add(OPPA[a]);
    setArms(d, drag.last, prevArms);
    // the tile we enter: an arm back, and for now straight on
    d.stairs.delete(toK);
    if (!drag.before.has(toK)) drag.before.set(toK, d.cuts.has(toK) ? d.cuts.get(toK) : null);
    const cur = armsOf(d.cuts.get(toK) || '');
    cur.add(OPPA[a]);
    if (!cur.has(a)) { cur.add(a); drag.prov.set(toK, a); }
    setArms(d, toK, cur);
    drag.last = toK;
  }
  function cutMove(h) {
    const k = key(Math.floor(h.lx), Math.floor(h.ly));
    if (k === drag.last) return false;
    // walk there one tile at a time (four-way), so fast drags leave no gaps
    let [x, y] = unkey(drag.last);
    const [tx, ty] = unkey(k);
    let guard = 0;
    while ((x !== tx || y !== ty) && guard++ < 200) {
      if (Math.abs(tx - x) >= Math.abs(ty - y)) x += Math.sign(tx - x); else y += Math.sign(ty - y);
      cutStep(key(x, y));
    }
    return true;
  }
  function cutEnd() {
    const d = doc.g(drag.uid);
    if (!drag.moved && drag.existed) {
      // a click on a cut tile: the arm on the side nearest the click goes on or off
      const h = drag.h0, x = Math.floor(h.lx), y = Math.floor(h.ly), fx = h.lx - x, fy = h.ly - y;
      const dist = { w: fx, e: 1 - fx, s: fy, n: 1 - fy };
      const a = Object.keys(dist).reduce((p, q) => dist[p] <= dist[q] ? p : q);
      const set = armsOf(d.cuts.get(drag.start));
      if (set.has(a)) set.delete(a); else set.add(a);
      if (set.size < 2) env.toast('A cut needs at least two arms. Alt+click removes the cut.', true);
      else setArms(d, drag.start, set);
    }
    // a drag that ends on a cut tile joins it there (a T) rather than crossing straight on
    if (drag.moved && drag.prov.has(drag.last) && drag.before.get(drag.last)) {
      const set = armsOf(d.cuts.get(drag.last)); set.delete(drag.prov.get(drag.last));
      if (set.size >= 2) setArms(d, drag.last, set);
    }
    for (const k of drag.before.keys()) joinNeighbours(d, k);
  }
  function edgeAt(h) {
    const d = doc.g(h.uid), x = Math.floor(h.lx), y = Math.floor(h.ly), fx = h.lx - x, fy = h.ly - y;
    const dist = { W: fx, E: 1 - fx, S: fy, N: 1 - fy };
    const side = Object.keys(dist).reduce((a, b) => dist[a] <= dist[b] ? a : b);
    const ek = edgeKey(x, y, side);
    if (d.edges.has(ek)) d.edges.delete(ek); else d.edges.add(ek);
  }
  function stairsAt(h, alt) {
    const d = doc.g(h.uid), x = Math.floor(h.lx), y = Math.floor(h.ly), k = key(x, y);
    if (alt) { d.stairs.delete(k); return; }
    d.cuts.delete(k);
    let dir = ui.stairDir;
    if (dir === 'auto') {
      if (d.stairs.has(k)) dir = CW[d.stairs.get(k)];
      else {
        let best = 'N', bestStep = -Infinity;
        for (const s of ['N', 'E', 'S', 'W']) {
          const [dx, dy] = DIRS[s];
          const hi = neighbourLevel(d, h.uid, x + dx, y + dy), lo = neighbourLevel(d, h.uid, x - dx, y - dy);
          if (hi === null || lo === null) continue;
          if (hi - lo > bestStep) { bestStep = hi - lo; best = s; }
        }
        dir = best;
      }
    }
    d.stairs.set(k, dir);
  }
  function eraseAt(h) {
    const d = doc.g(h.uid), x = Math.floor(h.lx), y = Math.floor(h.ly), k = key(x, y);
    d.cuts.delete(k); d.stairs.delete(k);
    for (const s of ['N', 'E', 'S', 'W']) d.edges.delete(edgeKey(x, y, s));
  }

  // ---- pointer (called by app.js while the Levels tool is active)
  function down(wx, wy, e) {
    const h = gridAt(wx, wy);
    if (!h) return;
    doc.snapshot();
    if (ui.mode === 'paint') {
      if (e.shiftKey) { drag = { kind: 'rect', uid: h.uid, gr: h.gr, a: [h.lx, h.ly], b: [h.lx, h.ly] }; env.redraw(); return; }
      drag = { kind: 'paint', uid: h.uid }; paintAt(h);
    } else if (ui.mode === 'cut') {
      if (e.altKey) { doc.g(h.uid).cuts.delete(key(Math.floor(h.lx), Math.floor(h.ly))); drag = { kind: 'uncut', uid: h.uid }; }
      else cutStart(h);
    } else if (ui.mode === 'edge') { edgeAt(h); drag = null; }
    else if (ui.mode === 'stairs') { stairsAt(h, e.altKey); drag = null; }
    else if (ui.mode === 'erase') { drag = { kind: 'erase', uid: h.uid }; eraseAt(h); }
    changed();
  }
  function move(wx, wy) {
    const h = gridAt(wx, wy);
    hover = h ? { uid: h.uid, gr: h.gr, x: Math.floor(h.lx), y: Math.floor(h.ly), lx: h.lx, ly: h.ly } : null;
    if (!drag) { env.redraw(); return; }
    if (!h || h.uid !== drag.uid) return;
    if (drag.kind === 'rect') { drag.b = [h.lx, h.ly]; env.redraw(); return; }
    if (drag.kind === 'paint') paintAt(h);
    else if (drag.kind === 'cut') { if (!cutMove(h)) return; }
    else if (drag.kind === 'uncut') doc.g(h.uid).cuts.delete(key(Math.floor(h.lx), Math.floor(h.ly)));
    else if (drag.kind === 'erase') eraseAt(h);
    changed();
  }
  function up() {
    if (drag && drag.kind === 'rect') {
      const d = doc.g(drag.uid);
      const x0 = Math.floor(Math.min(drag.a[0], drag.b[0])), x1 = Math.floor(Math.max(drag.a[0], drag.b[0]));
      const y0 = Math.floor(Math.min(drag.a[1], drag.b[1])), y1 = Math.floor(Math.max(drag.a[1], drag.b[1]));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 250000) {
        const tiles = tilesOf(drag.uid);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (tiles.has(key(x, y)) || ui.level === 0) paintTile(d, x, y, ui.level);
      } else env.toast('That area is too large', true);
      drag = null;
      changed();
      return;
    }
    if (drag && drag.kind === 'cut') { cutEnd(); drag = null; changed(); return; }
    drag = null;
  }
  function leave() { hover = null; env.redraw(); }

  function applyToArea() {
    const a = env.getArea();
    if (!a || !a.tiles || !a.tiles.size) { env.toast('Select an area first (Pick tool, drag; or a room in the Area tab)', true); return; }
    doc.snapshot();
    const d = doc.g(String(a.grid));
    for (const k of a.tiles) { const [x, y] = unkey(k); paintTile(d, x, y, ui.level); }
    changed();
    env.toast(`${fmt(ui.level)} set on ${a.tiles.size} tiles`);
  }

  // ---- drawing (in app.js's overlay, world space per grid)
  function draw(g) {
    const R = env.getRenderer();
    if (!R.grids) return;
    const s = env.camScale();
    for (const [uid, d] of doc.grids) {
      const gr = R.grids.get(+uid) || R.grids.get(uid);
      if (!gr || (!ui.show && !(drag && drag.kind === 'rect'))) continue;
      const an = analysis.get(uid);
      g.save();
      env.setGridXf(g, gr);
      if (ui.show) {
        // level colours: each tile, cut tiles in their two halves
        if (!ui.onlyMarks) {
          const byColor = new Map();
          const add = (c, x, y, w, h) => { if (!byColor.has(c)) byColor.set(c, new Path2D()); byColor.get(c).rect(x, y, w, h); };
          for (const [k, v] of d.levels) {
            if (d.cuts.has(k) || d.stairs.has(k) || v === 0) continue;
            const [x, y] = unkey(k); add(levelColor(v), x, y, 1, 1);
          }
          if (an) for (const k of d.cuts.keys()) {
            const [x, y] = unkey(k);
            [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]].forEach(([ox, oy], i) => {
              const v = an.quarter(x, y, i);
              if (typeof v === 'number' && v !== 0) add(levelColor(v), x + ox, y + oy, 0.5, 0.5);
            });
          }
          g.globalAlpha = 0.38;
          for (const [c, p] of byColor) { g.fillStyle = c; g.fill(p); }
          g.globalAlpha = 1;
        }
        // stairs: tile, arrow, label
        for (const [k, dir] of d.stairs) {
          const [x, y] = unkey(k);
          const info = an && an.stairInfo.find(i => i.x === x && i.y === y);
          g.fillStyle = 'rgba(20,24,30,.55)'; g.fillRect(x + 0.04, y + 0.04, 0.92, 0.92);
          g.strokeStyle = info && info.airlock ? '#5ad1ff' : '#ffffff'; g.lineWidth = (info && info.airlock ? 3 : 1.5) / s;
          g.strokeRect(x + 0.04, y + 0.04, 0.92, 0.92);
          g.save(); g.translate(x + 0.5, y + 0.5);
          g.rotate({ N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 }[dir]);
          g.beginPath(); g.moveTo(0, 0.36); g.lineTo(0.22, 0.12); g.lineTo(0.08, 0.12); g.lineTo(0.08, -0.34); g.lineTo(-0.08, -0.34); g.lineTo(-0.08, 0.12); g.lineTo(-0.22, 0.12); g.closePath();
          g.fillStyle = info && info.kind ? '#ffffff' : '#ff5a5a'; g.fill();
          g.restore();
          if (s >= 18) {
            const label = (info && info.kind ? info.kind.label : '?') + (info && info.airlock ? ' · airlock' : '');
            g.save(); g.translate(x + 0.5, y + 0.5); g.scale(1 / s, -1 / s);
            g.font = `bold ${Math.max(9, Math.min(13, s * 0.26))}px system-ui, sans-serif`;
            g.textAlign = 'center'; g.textBaseline = 'middle';
            const tx = { N: 0, S: 0, E: -s * 0.3, W: s * 0.3 }[dir], ty = { N: s * 0.33, S: -s * 0.33, E: 0, W: 0 }[dir];
            g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeText(label, tx, ty);
            g.fillStyle = '#fff'; g.fillText(label, tx, ty);
            g.restore();
          }
        }
        // cut lines
        if (an) {
          g.strokeStyle = '#ff2bd6'; g.lineWidth = Math.max(2.5, s * 0.07) / s; g.lineCap = 'round';
          g.beginPath();
          for (const [x0, y0, x1, y1] of an.cutLines) { g.moveTo(x0, y0); g.lineTo(x1, y1); }
          g.stroke();
          // stubs: bottom (low side) outlined, top (high side) filled, beside the line
          for (const st of an.stubs) {
            const off = 0.14, len = st.len || 0.56, th = 0.09;
            const sgn = (st.side === 'E' || st.side === 'N') ? 1 : -1;
            let rx, ry, rw, rh;
            if (st.ax === 'v') { rx = st.x + sgn * off - th / 2; ry = st.y - len / 2; rw = th; rh = len; }
            else { rx = st.x - len / 2; ry = st.y + sgn * off - th / 2; rw = len; rh = th; }
            if (st.kind === 'top') { g.fillStyle = '#ffd23f'; g.fillRect(rx, ry, rw, rh); }
            else { g.strokeStyle = '#3fe0ff'; g.lineWidth = 1.5 / s; g.strokeRect(rx, ry, rw, rh); }
          }
          // problems: red edges, orange corners
          g.strokeStyle = '#ff3b3b'; g.lineWidth = Math.max(2, s * 0.05) / s;
          g.setLineDash([4 / s, 3 / s]);
          g.beginPath();
          for (const e of an.errEdges) {
            const p = e.split(','), x = +p[0], y = +p[1];
            if (p[2] === 'E') { g.moveTo(x + 1, y); g.lineTo(x + 1, y + 1); } else { g.moveTo(x, y + 1); g.lineTo(x + 1, y + 1); }
          }
          g.stroke(); g.setLineDash([]);
          for (const w of an.warnings) if (w.kind === 'check') {
            g.beginPath(); g.arc(w.x, w.y, Math.max(4, s * 0.12) / s, 0, Math.PI * 2);
            g.strokeStyle = '#ffa53b'; g.lineWidth = 2 / s; g.stroke();
          }
        }
      }
      g.restore();
    }
    // the rectangle being dragged, and the brush/hover outline
    if (drag && drag.kind === 'rect') {
      const gr = drag.gr;
      g.save(); env.setGridXf(g, gr);
      const x0 = Math.floor(Math.min(drag.a[0], drag.b[0])), x1 = Math.floor(Math.max(drag.a[0], drag.b[0])) + 1;
      const y0 = Math.floor(Math.min(drag.a[1], drag.b[1])), y1 = Math.floor(Math.max(drag.a[1], drag.b[1])) + 1;
      g.fillStyle = levelColor(ui.level); g.globalAlpha = 0.25; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.globalAlpha = 1;
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 / s; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
    } else if (hover && env.isActive()) {
      g.save(); env.setGridXf(g, hover.gr);
      g.lineWidth = 2 / s;
      if (ui.mode === 'edge') {
        const fx = hover.lx - hover.x, fy = hover.ly - hover.y;
        const dist = { W: fx, E: 1 - fx, S: fy, N: 1 - fy };
        const side = Object.keys(dist).reduce((a, b) => dist[a] <= dist[b] ? a : b);
        const x = hover.x, y = hover.y;
        g.strokeStyle = '#ff2bd6'; g.beginPath();
        if (side === 'W') { g.moveTo(x, y); g.lineTo(x, y + 1); } else if (side === 'E') { g.moveTo(x + 1, y); g.lineTo(x + 1, y + 1); }
        else if (side === 'S') { g.moveTo(x, y); g.lineTo(x + 1, y); } else { g.moveTo(x, y + 1); g.lineTo(x + 1, y + 1); }
        g.stroke();
      } else {
        const r = ui.mode === 'paint' ? (ui.brush - 1) / 2 : 0;
        g.strokeStyle = ui.mode === 'paint' ? levelColor(ui.level) : ui.mode === 'erase' ? '#ffffff' : '#ff2bd6';
        g.strokeRect(hover.x - r, hover.y - r, 1 + 2 * r, 1 + 2 * r);
      }
      g.restore();
    }
  }

  // ---- files
  function mapBaseName() {
    const src = env.mapSource();
    const n = String((src && src.name) || 'map').split('/').pop();
    return n.replace(/\.ya?ml$/i, '');
  }
  async function save() {
    const src = env.mapSource();
    if (!src) { env.toast('Open a map first', true); return; }
    const sha = mapSha1 || (mapSha1 = await sha1(src.text));
    const file = doc.toFile(String(src.name || 'map.yml').split('/').pop(), sha);
    const all = [...analysis.values()].flatMap(a => a.warnings);
    const errors = all.filter(w => w.kind === 'error').length, checks = all.length - errors;
    env.download(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }), env.safeName(mapBaseName()) + '.levels.json');
    env.toast(all.length ? `Saved with ${errors} error${errors === 1 ? '' : 's'} and ${checks} to check` : 'Saved, no warnings');
  }
  async function loadFile(f) {
    let j;
    try { j = JSON.parse(await f.text()); } catch (e) { env.toast('Not a JSON file', true); return false; }
    return loadJson(j, f.name);
  }
  async function loadJson(j, name) {
    if (!j || j.format !== 'ss14-levels') return false;
    if (!env.mapSource()) { env.toast('Open the map first, then its levels file', true); return true; }
    try {
      doc.snapshot();
      doc.fromFile(j);
    } catch (e) { env.toast('Could not read the levels file: ' + e.message, true); return true; }
    const src = env.mapSource();
    const sha = mapSha1 || (mapSha1 = await sha1(src.text));
    fileNote = '';
    if (j.map_sha1 && sha && j.map_sha1 !== sha) fileNote = `${name || 'This file'} was made for a different version of the map (its SHA-1 doesn't match). Check the cuts and stairs.`;
    else if (j.map && j.map.toLowerCase() !== String(src.name || '').split('/').pop().toLowerCase()) fileNote = `${name || 'This file'} was made for ${j.map}.`;
    changed();
    env.toast(fileNote || 'Levels loaded', !!fileNote);
    return true;
  }

  // ---- map opened
  async function mapLoaded() {
    doc.grids = new Map(); doc.undoStack = []; doc.redoStack = [];
    fileNote = ''; mapSha1 = null;
    const saved = env.lsGet('levels.' + env.mapKey());
    if (saved) doc.restore(saved);
    const src = env.mapSource();
    if (src) sha1(src.text).then(s => { mapSha1 = s; });
    reanalyse();
    renderPane();
  }
  function sceneReady() { tileSets = { scene: null, map: new Map() }; reanalyse(); renderPane(); env.redraw(); }

  // ---- the pane
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderPane() {
    const p = env.pane;
    if (!p) return;
    const all = [];
    for (const [uid, a] of analysis) for (const w of a.warnings) all.push({ ...w, uid });
    all.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1));
    const errors = all.filter(w => w.kind === 'error').length, checks = all.length - errors;
    let painted = 0, cuts = 0, edges = 0, stairs = 0;
    for (const d of doc.grids.values()) { painted += d.levels.size; cuts += d.cuts.size; edges += d.edges.size; stairs += d.stairs.size; }
    const area = env.getArea();
    const modeBtn = (m, label, title) => `<button class="btn small lvmode${ui.mode === m ? ' on' : ''}" data-m="${m}" title="${title}">${label}</button>`;
    const opt = (name, v, label, cur) => `<button class="btn small lvopt${cur === v ? ' on' : ''}" data-o="${name}" data-v="${v}">${label}</button>`;
    p.innerHTML = `
      <h3>Levels</h3>
      <p class="hint">Heights for the Blender importer, saved next to the map as <b>${esc(mapBaseName())}.levels.json</b>. The map itself isn't changed.</p>
      ${fileNote ? `<p class="lvnote">${esc(fileNote)}</p>` : ''}
      <div class="row gap wrap">
        <label class="tglbtn"><input type="checkbox" id="lvShow" ${ui.show ? 'checked' : ''}> Show overlay</label>
        <label class="tglbtn"><input type="checkbox" id="lvOnly" ${ui.onlyMarks ? 'checked' : ''}> Only cuts and stairs</label>
      </div>
      <h4>Tool</h4>
      <div class="row gap wrap">
        ${modeBtn('paint', 'Paint level', 'Drag to paint tiles. Shift+drag paints a rectangle.')}
        ${modeBtn('cut', 'Cut tile', 'Drag along the tiles the cut goes through: it bends around corners and joins other cuts (T, cross) and stairs. Click a cut tile near an edge to add or remove that arm. Alt+click removes.')}
        ${modeBtn('edge', 'Edge cut', 'Click next to a tile edge to cut exactly on that edge (or remove it).')}
        ${modeBtn('stairs', 'Stairs', 'Click a tile to make it stairs. Auto points them uphill; clicking again turns them. Alt+click removes.')}
        ${modeBtn('erase', 'Erase marks', 'Drag to remove cuts, edge cuts and stairs (levels stay; paint 0 to clear a level).')}
      </div>
      <h4>Level</h4>
      <div class="lvlevels">${LEVELS.map(v => `<button class="lvlv${ui.level === v ? ' on' : ''}" data-v="${v}" style="--c:${levelColor(v)}">${v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v)}</button>`).join('')}</div>
      <div class="row gap">
        <label class="row">Metres <input type="number" id="lvNum" step="0.75" min="-3" max="3" value="${ui.level}" style="width:5em"></label>
        <label class="row">Brush ${[1, 3, 5].map(b => `<button class="btn small lvbrush${ui.brush === b ? ' on' : ''}" data-b="${b}">${b}×${b}</button>`).join('')}</label>
      </div>
      <button class="btn small" id="lvArea" ${area && area.tiles && area.tiles.size ? '' : 'disabled'}>Set ${fmt(ui.level)} on the Area selection${area && area.tiles && area.tiles.size ? ` (${area.tiles.size} tiles)` : ''}</button>
      <h4>New cut tile on a click</h4>
      <div class="row gap">${opt('cutDir', 'auto', 'Auto (joins cuts and stairs)', ui.cutDir)}${opt('cutDir', 'ns', 'North–south', ui.cutDir)}${opt('cutDir', 'we', 'West–east', ui.cutDir)}</div>
      <h4>Stairs rise</h4>
      <div class="row gap">${opt('stairDir', 'auto', 'Auto', ui.stairDir)}${['N', 'E', 'S', 'W'].map(dd => opt('stairDir', dd, dd, ui.stairDir)).join('')}</div>
      <h4>Legend</h4>
      <div class="lvlegend">
        ${LEVELS.filter(v => v !== 0).map(v => `<span><i style="background:${levelColor(v)}"></i>${fmt(v)}</span>`).join('')}
        <span><i class="cutsw"></i>cut line</span>
        <span><i class="stubb"></i>bottom stub (low side)</span>
        <span><i class="stubt"></i>top stub (high side)</span>
        <span><i class="errsw"></i>levels touching</span>
        <span><i class="airsw"></i>stairs in an airlock</span>
      </div>
      <p class="hint">Stairs: <b>0.75</b> small stairs, <b>1.5</b> steep stairs, anything else a ladder. Unpainted tiles are level 0.</p>
      <h4>Warnings <span class="lvcount">${errors} error${errors === 1 ? '' : 's'}, ${checks} to check</span></h4>
      <div class="lvwarn">${all.length ? all.slice(0, 300).map((w, i) => `<button class="lvw ${w.kind}" data-i="${i}">${w.kind === 'check' ? 'Check: ' : ''}${esc(w.msg)} <small>(${Math.floor(w.x)}, ${Math.floor(w.y)})</small></button>`).join('') + (all.length > 300 ? `<p class="hint">…and ${all.length - 300} more</p>` : '') : '<p class="hint">None.</p>'}</div>
      <h4>File</h4>
      <p class="hint">${painted} tiles painted, ${cuts} cut tiles, ${edges} edge cuts, ${stairs} stairs${(() => { let n = 0; for (const a of analysis.values()) n += a.stairInfo.filter(i => i.airlock).length; return n ? ` (${n} in an airlock)` : ''; })()}.</p>
      <div class="row gap wrap">
        <button class="btn primary small" id="lvSave">Save .levels.json</button>
        <button class="btn small" id="lvOpen">Open .levels.json</button>
        <button class="btn small" id="lvClear">Clear all</button>
        <input type="file" id="lvFile" accept=".json,application/json" hidden>
      </div>`;
    p.querySelector('#lvShow').onchange = (e) => { ui.show = e.target.checked; env.redraw(); };
    p.querySelector('#lvOnly').onchange = (e) => { ui.onlyMarks = e.target.checked; env.redraw(); };
    p.querySelectorAll('.lvmode').forEach(b => b.onclick = () => { ui.mode = b.dataset.m; env.setTool('levels'); renderPane(); });
    p.querySelectorAll('.lvopt').forEach(b => b.onclick = () => { ui[b.dataset.o] = b.dataset.v; renderPane(); });
    p.querySelectorAll('.lvlv').forEach(b => b.onclick = () => { ui.level = +b.dataset.v; if (ui.mode !== 'paint') ui.mode = 'paint'; env.setTool('levels'); renderPane(); });
    p.querySelectorAll('.lvbrush').forEach(b => b.onclick = () => { ui.brush = +b.dataset.b; renderPane(); });
    p.querySelector('#lvNum').onchange = (e) => { ui.level = SNAP(+e.target.value || 0); renderPane(); };
    p.querySelector('#lvArea').onclick = applyToArea;
    p.querySelectorAll('.lvw').forEach(b => b.onclick = () => { const w = all[+b.dataset.i]; env.jumpTo(w.uid, w.x, w.y); });
    p.querySelector('#lvSave').onclick = save;
    const fi = p.querySelector('#lvFile');
    p.querySelector('#lvOpen').onclick = () => fi.click();
    fi.onchange = async () => { const f = fi.files[0]; fi.value = ''; if (f && !(await loadFile(f))) env.toast('That is not a levels file', true); };
    p.querySelector('#lvClear').onclick = () => {
      if (doc.empty) return;
      if (!confirm('Remove every level, cut and stairs from this map?')) return;
      doc.snapshot(); doc.grids = new Map(); fileNote = ''; changed();
    };
  }

  return {
    down, move, up, leave, draw, mapLoaded, sceneReady, loadFile, loadJson, renderPane,
    undo() { if (doc.undo()) changed(); }, redo() { if (doc.redo()) changed(); },
    get doc() { return doc; },
  };
}
