// Levels editor (file version 2): per tile a floor level and a roof level (in levels of 0.75 m), cut tiles,
// edge cuts and stairs, checked against the rules and saved as <mapname>.levels.json for the Blender
// importer. The map .yml is never changed. Spec: claude/LEVELS_EDITOR_REQUEST.md (v2),
// claude/LEVELS_EDITOR_REPLY.md, claude/LEVELS_EDITOR_MANUAL_CUTS.md.
//
// Coordinates: grid entity uid from the map file; tile x, y are the grid's local tile indices
// (chunk index * 16 + position in the chunk, y up), the same keys as the Area selection ("x,y").
//
// Every tile is looked at as four quarters (sw, se, nw, ne). A plain floor tile has its floor and roof in
// all four. A cut tile is a set of arms from its centre to its edge middles; quarters not separated by an
// arm form a region, which takes the floor and roof of its side neighbours unless the user set them by
// hand (cut_levels). Walls, windows and doors (the importer's boundary tiles) have no level: they are cut
// in half anyway, so levels may differ across them. A tile that was never painted counts as 0; a tile
// painted 0 is "assigned" and shown in the 0 colour.

export const LV_MIN = -4, LV_MAX = 4, MAX_STEP = 4, LEVEL_M = 0.75;
export const LEVELS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const COLORS = {
  '-4': '#2a36d8', '-3': '#3346ff', '-2': '#3f86ff', '-1': '#4fd0f0',
  '0': '#4fd97a', '1': '#ffe066', '2': '#ffae42', '3': '#ff7038', '4': '#ff3366',
};
const DIRS = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
const CW = { N: 'E', E: 'S', S: 'W', W: 'N' };
const CLAMP = (v) => Math.max(LV_MIN, Math.min(LV_MAX, Math.round(+v || 0))) + 0;
const fmt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
const key = (x, y) => x + ',' + y;
const unkey = (k) => { const i = k.indexOf(','); return [+k.slice(0, i), +k.slice(i + 1)]; };
export const levelColor = (v) => COLORS[String(CLAMP(v))] || '#ffffff';
export function stairKind(step) {
  const d = Math.abs(step);
  if (d === 1) return { label: 'small', name: 'small stairs' };
  if (d === 2) return { label: 'steep', name: 'steep stairs' };
  return { label: 'ladder', name: 'ladder' };
}

// Cut shapes: arm letters in the order n, s, w, e. An arm separates two quarters.
const ARM_ORDER = ['n', 's', 'w', 'e'];
export const canonArms = (str) => { const set = new Set(String(str || '').toLowerCase()); return ARM_ORDER.filter(a => set.has(a)).join(''); };
const armsOf = (str) => new Set(String(str || ''));
const ARM_SEP = { n: [2, 3], e: [3, 1], s: [1, 0], w: [0, 2] };   // quarters: 0 sw, 1 se, 2 nw, 3 ne
const QNAMES = ['sw', 'se', 'nw', 'ne'];
const ROT_CW = { n: 'e', e: 's', s: 'w', w: 'n' };
export const SHAPES = [
  ['Straight', ['ns', 'we']], ['Corners', ['ne', 'se', 'sw', 'nw']], ["T's", ['nsw', 'nse', 'nwe', 'swe']], ['Cross', ['nswe']],
];
export const rotateShape = (arms) => canonArms([...arms].map(a => ROT_CW[a]).join(''));
function shapeSvg(arms, size = 26) {
  const c = size / 2, e = { n: [c, 2], s: [c, size - 2], w: [2, c], e: [size - 2, c] };
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="3" fill="none" stroke="currentColor" stroke-opacity=".35"/>`
    + [...arms].map(a => `<line x1="${c}" y1="${c}" x2="${e[a][0]}" y2="${e[a][1]}" stroke="#ff2bd6" stroke-width="3" stroke-linecap="round"/>`).join('') + '</svg>';
}

// The importer's boundary tiles (request §1): walls, windows, doors, by proto name
export function protoKind(name) {
  const n = String(name || '').toLowerCase();
  if (/floor|lattice|plating|catwalk|carpet/.test(n)) return null;            // a floor item
  if (n.includes('windoor') || n.includes('directional')) return 'thin';      // sits on an edge, doesn't close the tile
  if (/airlock|blastdoor|firelock|gaslock|wooddoor|plasticflaps|flaps/.test(n)) return 'door';
  if (/window|grille|shutters|tinted/.test(n)) return 'window';
  if (n.includes('wall')) return 'wall';
  return null;
}

async function sha1(text) {
  try {
    const t = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- the data
class GridLevels {
  constructor() {
    this.floor = new Map(); this.roof = new Map(); this.cuts = new Map(); this.edges = new Set(); this.stairs = new Map();
    this.cutLevels = new Map();     // "x,y" -> { sw: { floor, roof }, ... } set by hand
    this.stairLevels = new Map();   // "x,y" -> floor level of the bottom step, set by hand
  }
  get empty() { return !this.floor.size && !this.roof.size && !this.cuts.size && !this.edges.size && !this.stairs.size && !this.cutLevels.size && !this.stairLevels.size; }
}
// an edge is stored once, as E or N of a tile
function edgeKey(x, y, side) {
  if (side === 'W') { x -= 1; side = 'E'; }
  if (side === 'S') { y -= 1; side = 'N'; }
  return x + ',' + y + ',' + side;
}

export class LevelsDoc {
  constructor() { this.grids = new Map(); this.undoStack = []; this.redoStack = []; }
  g(uid) { uid = String(uid); if (!this.grids.has(uid)) this.grids.set(uid, new GridLevels()); return this.grids.get(uid); }
  serialize() {
    const out = {};
    for (const [uid, d] of this.grids) {
      if (d.empty) continue;
      out[uid] = { floor: [...d.floor], roof: [...d.roof], cuts: [...d.cuts], edges: [...d.edges], stairs: [...d.stairs], cutLevels: [...d.cutLevels], stairLevels: [...d.stairLevels] };
    }
    return { v: 2, grids: out };
  }
  restore(o) {
    this.grids = new Map();
    if (!o) return;
    const grids = o.v === 2 ? o.grids : o;           // older saves: { uid: { levels (metres), cuts, … } }
    for (const uid of Object.keys(grids || {})) {
      const d = this.g(uid), s = grids[uid];
      d.floor = new Map(s.floor || (s.levels || []).map(([k, v]) => [k, CLAMP(v / LEVEL_M)]));
      d.roof = new Map(s.roof || []); d.cuts = new Map(s.cuts || []);
      d.edges = new Set(s.edges || []); d.stairs = new Map(s.stairs || []);
      d.cutLevels = new Map(s.cutLevels || []); d.stairLevels = new Map(s.stairLevels || []);
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

  // the sidecar file, version 2
  toFile(mapName, mapSha1) {
    const grids = {};
    const sorted = (it) => [...it].sort((a, b) => { const [ax, ay] = unkey(a[0]), [bx, by] = unkey(b[0]); return ay - by || ax - bx; });
    for (const [uid, d] of this.grids) {
      if (d.empty) continue;
      const floor = {}, roof = {}, cuts = {}, stairs = {}, cutLevels = {}, stairLevels = {};
      for (const [k, v] of sorted(d.floor)) floor[k] = v;
      for (const [k, v] of sorted(d.roof)) roof[k] = v;
      for (const [k, v] of sorted(d.cuts)) cuts[k] = v;
      for (const [k, v] of sorted(d.stairs)) stairs[k] = v;
      for (const [k, v] of sorted(d.stairLevels)) if (d.stairs.has(k)) stairLevels[k] = v;
      for (const [k, v] of sorted(d.cutLevels)) {
        const o = {};
        for (const q of QNAMES) if (v[q] && (v[q].floor != null || v[q].roof != null)) {
          o[q] = {};
          if (v[q].floor != null) o[q].floor = v[q].floor;
          if (v[q].roof != null) o[q].roof = v[q].roof;
        }
        if (Object.keys(o).length) cutLevels[k] = o;
      }
      const edges = [...d.edges].map(e => { const p = e.split(','); return { x: +p[0], y: +p[1], side: p[2] }; })
        .sort((a, b) => a.y - b.y || a.x - b.x || (a.side < b.side ? -1 : 1));
      grids[uid] = { floor, roof, cuts, edges, stairs };
      if (Object.keys(cutLevels).length) grids[uid].cut_levels = cutLevels;
      if (Object.keys(stairLevels).length) grids[uid].stair_levels = stairLevels;
    }
    return { format: 'ss14-levels', version: 2, map: mapName, map_sha1: mapSha1 || '', level_m: LEVEL_M, grids };
  }
  fromFile(j) {
    if (!j || j.format !== 'ss14-levels') throw new Error('this is not an ss14-levels file');
    if (j.version !== 1 && j.version !== 2) throw new Error('unknown version ' + j.version);
    this.grids = new Map();
    for (const uid of Object.keys(j.grids || {})) {
      const s = j.grids[uid], d = this.g(uid);
      if (j.version === 1) for (const [k, v] of Object.entries(s.levels || {})) d.floor.set(k, CLAMP(+v / LEVEL_M));
      else {
        for (const [k, v] of Object.entries(s.floor || {})) d.floor.set(k, CLAMP(v));
        for (const [k, v] of Object.entries(s.roof || {})) d.roof.set(k, Math.round(+v || 0));
        for (const [k, v] of Object.entries(s.cut_levels || {})) {
          const o = {};
          for (const q of QNAMES) if (v && v[q]) {
            o[q] = {};
            if (v[q].floor != null) o[q].floor = CLAMP(v[q].floor);
            if (v[q].roof != null) o[q].roof = Math.round(+v[q].roof || 0);
          }
          if (Object.keys(o).length) d.cutLevels.set(k, o);
        }
        for (const [k, v] of Object.entries(s.stair_levels || {})) d.stairLevels.set(k, CLAMP(v));
      }
      for (const [k, v] of Object.entries(s.cuts || {})) { const a = canonArms(v); if (a.length >= 2 && a.length === String(v).length) d.cuts.set(k, a); }
      for (const e of (s.edges || [])) if (DIRS[e.side]) d.edges.add(edgeKey(+e.x, +e.y, e.side));
      for (const [k, v] of Object.entries(s.stairs || {})) if (DIRS[v]) d.stairs.set(k, v);
    }
  }
}

// ---------------------------------------------------------------- checking
// tiles: Set "x,y" of tiles with a floor; bounds: Map "x,y" -> 'wall'|'window'|'door' (boundary tiles).
export function analyse(d, tiles, bounds = new Map()) {
  const exists = (x, y) => { const k = key(x, y); return tiles.has(k) || d.floor.has(k) || d.cuts.has(k) || d.stairs.has(k); };
  // a quarter's value: { f, r } (floor, roof relative to the floor), null (no tile, wall/window/door, unknown) or 'S' (stairs)
  const base = (x, y) => {
    const k = key(x, y);
    if (!exists(x, y)) return null;
    if (d.stairs.has(k)) return 'S';
    if (bounds.has(k) && !d.cuts.has(k)) return null;
    return { f: d.floor.get(k) || 0, r: d.roof.get(k) || 0 };
  };
  const isVal = (v) => v && typeof v === 'object';
  const warnings = [];
  const warn = (kind, x, y, msg) => warnings.push({ kind, x, y, msg });

  // cut tiles: regions, hand-set values, then the rest from the side neighbours (solved together)
  const OUTER = [[[0, -1, 2], [-1, 0, 1]], [[0, -1, 3], [1, 0, 0]], [[0, 1, 0], [-1, 0, 3]], [[0, 1, 1], [1, 0, 2]]];
  const regionsOf = new Map(), cutQ = new Map(), manual = new Map();
  for (const [k, arms] of d.cuts) {
    if (d.stairs.has(k)) continue;                 // stairs cut through: still stairs, the cut only splits them
    const A = armsOf(arms), parent = [0, 1, 2, 3];
    const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (const a of ['n', 'e', 's', 'w']) if (!A.has(a)) { const [p, q] = ARM_SEP[a]; parent[find(p)] = find(q); }
    const groups = new Map();
    for (let i = 0; i < 4; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    regionsOf.set(k, [...groups.values()]);
    cutQ.set(k, [null, null, null, null]);
    const ov = d.cutLevels.get(k) || {}, man = [0, 1, 2, 3].map(() => ({ floor: false, roof: false }));
    const [x, y] = unkey(k);
    for (const reg of regionsOf.get(k)) {
      for (const field of ['floor', 'roof']) {
        const vals = reg.map(i => ov[QNAMES[i]] && ov[QNAMES[i]][field]).filter(v => v != null);
        if (!vals.length) continue;
        if (new Set(vals).size > 1) warn('error', x + 0.5, y + 0.5, `Hand-set ${field} levels disagree within one part of this cut tile (${vals.map(fmt).join(', ')})`);
        for (const i of reg) man[i][field] = vals[0];
      }
    }
    manual.set(k, man);
  }
  const quarter = (x, y, i) => { const k = key(x, y); return cutQ.has(k) ? cutQ.get(k)[i] : base(x, y); };
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (const [k, regions] of regionsOf) {
      const [x, y] = unkey(k), q = cutQ.get(k), man = manual.get(k);
      for (const reg of regions) {
        const count = new Map();
        for (const i of reg) for (const [dx, dy, j] of OUTER[i]) {
          const v = quarter(x + dx, y + dy, j);
          if (isVal(v)) { const kk = v.f + '|' + v.r; count.set(kk, (count.get(kk) || 0) + 1); }
        }
        let best = null, bn = 0;
        for (const [v, n] of count) if (n > bn) { best = v; bn = n; }
        const auto = best ? best.split('|').map(Number) : null;
        const m = man[reg[0]];
        const f = m.floor !== false ? m.floor : auto ? auto[0] : null;
        const r = m.roof !== false ? m.roof : auto ? auto[1] : 0;
        const val = f == null ? null : { f, r };
        for (const i of reg) {
          const o = q[i];
          if ((o === null) !== (val === null) || (o && val && (o.f !== val.f || o.r !== val.r))) { q[i] = val; moved = true; }
        }
      }
    }
    if (!moved) break;
  }
  for (const k of d.cutLevels.keys()) if (!d.cuts.has(k) || d.stairs.has(k)) { const [x, y] = unkey(k); warn('check', x + 0.5, y + 0.5, 'Hand-set cut levels on a tile that is no longer a plain cut tile (ignored; the eraser drops them)'); }

  // the tiles worth looking at: everything marked and its neighbours
  const marked = new Set([...d.floor.keys(), ...d.roof.keys(), ...d.cuts.keys(), ...d.stairs.keys()]);
  for (const e of d.edges) { const p = e.split(','); marked.add(p[0] + ',' + p[1]); const [dx, dy] = DIRS[p[2]]; marked.add(key(+p[0] + dx, +p[1] + dy)); }
  const look = new Set();
  for (const k of marked) { const [x, y] = unkey(k); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) look.add(key(x + dx, y + dy)); }

  const stubs = [], cutLines = [], errEdges = new Set();
  const stubPair = (a, b, sa, sb, pos) => {
    if (a.f !== b.f) stubs.push({ ...pos, side: a.f < b.f ? sa : sb, kind: 'floor', h: Math.abs(a.f - b.f) });
    const ra = a.f + a.r, rb = b.f + b.r;
    if (ra !== rb) stubs.push({ ...pos, side: ra > rb ? sa : sb, kind: 'roof', h: Math.abs(ra - rb) });
  };
  const tooBig = (a, b, x, y) => {
    if (Math.abs(a.f - b.f) > MAX_STEP) warn('error', x, y, `Floor step of ${Math.abs(a.f - b.f)} levels (more than ${MAX_STEP})`);
    else if (Math.abs((a.f + a.r) - (b.f + b.r)) > MAX_STEP) warn('error', x, y, `Roof step of ${Math.abs((a.f + a.r) - (b.f + b.r))} levels (more than ${MAX_STEP})`);
  };

  // 1. tile edges: floors may only differ across a cut; roofs step anywhere
  for (const k of look) {
    const [x, y] = unkey(k);
    for (const side of ['E', 'N']) {
      const [dx, dy] = DIRS[side], bx = x + dx, by = y + dy;
      if (!exists(x, y) || !exists(bx, by)) continue;
      const ek = edgeKey(x, y, side), isEdgeCut = d.edges.has(ek);
      const pairs = side === 'E' ? [[1, 0], [3, 2]] : [[2, 0], [3, 1]];
      const mx = x + 0.5 + dx / 2, my = y + 0.5 + dy / 2;
      if (isEdgeCut) cutLines.push(side === 'E' ? [x + 1, y, x + 1, y + 1] : [x, y + 1, x + 1, y + 1]);
      let floorErr = null, sameFloor = true, any = false;
      for (let pi = 0; pi < 2; pi++) {
        const [qa, qb] = pairs[pi];
        const a = quarter(x, y, qa), b = quarter(bx, by, qb);
        if (!isVal(a) || !isVal(b)) continue;
        any = true;
        const half = side === 'E' ? { x: x + 1, y: y + 0.25 + pi * 0.5, ax: 'v', len: 0.3 } : { x: x + 0.25 + pi * 0.5, y: y + 1, ax: 'h', len: 0.3 };
        const sa = side === 'E' ? 'W' : 'S', sb = side === 'E' ? 'E' : 'N';
        if (a.f !== b.f) sameFloor = false;
        if (a.f !== b.f && !isEdgeCut) { floorErr = floorErr || [a.f, b.f]; continue; }
        stubPair(a, b, sa, sb, half);
        tooBig(a, b, mx, my);
      }
      if (floorErr) { errEdges.add(ek); warn('error', mx, my, `Floor ${fmt(floorErr[0])} and ${fmt(floorErr[1])} touch with no cut between them`); }
      if (isEdgeCut && any && sameFloor) warn('check', mx, my, 'Edge cut between two tiles on the same floor level');
    }
  }

  // 2. cut tiles: arms, stubs per arm, two different floors around it
  const ARM_END = { n: [0.5, 1], s: [0.5, 0], w: [0, 0.5], e: [1, 0.5] };
  for (const [k, arms] of d.cuts) {
    const [x, y] = unkey(k);
    if (d.stairs.has(k)) { for (const a of arms) { const [ex, ey] = ARM_END[a]; cutLines.push([x + 0.5, y + 0.5, x + ex, y + ey]); } continue; }
    const q = cutQ.get(k);
    const floors = new Set(q.filter(isVal).map(v => v.f));
    for (const a of arms) {
      const [ex, ey] = ARM_END[a];
      cutLines.push([x + 0.5, y + 0.5, x + ex, y + ey]);
      const [qa, qb] = ARM_SEP[a].map(i => q[i]);
      if (!isVal(qa) || !isVal(qb)) continue;
      const sides = { n: ['W', 'E'], e: ['N', 'S'], s: ['E', 'W'], w: ['S', 'N'] }[a];
      const pos = { x: x + (0.5 + ex) / 2, y: y + (0.5 + ey) / 2, ax: (a === 'n' || a === 's') ? 'v' : 'h', len: 0.3 };
      stubPair(qa, qb, sides[0], sides[1], pos);
      tooBig(qa, qb, x + 0.5, y + 0.5);
    }
    if (floors.size < 2) {
      const lvl = (xx, yy) => { const v = base(xx, yy); return isVal(v) && !d.cuts.has(key(xx, yy)) ? v.f : null; };
      const n = lvl(x, y + 1), s2 = lvl(x, y - 1), w = lvl(x - 1, y), e = lvl(x + 1, y);
      const num = (v) => typeof v === 'number';
      const wrong = arms === 'ns' ? (num(n) && num(s2) && n !== s2) : arms === 'we' ? (num(w) && num(e) && w !== e) : false;
      warn('error', x + 0.5, y + 0.5, wrong
        ? `Cut line runs the wrong way: the floor changes ${arms === 'ns' ? 'south to north (use a west–east line)' : 'west to east (use a north–south line)'}`
        : 'Cut tile without two different floor levels around it');
    }
  }

  // 3. stairs: bottom step = the set level, else the tile in front; top = the tile behind
  const stairInfo = [];
  for (const [k, dir] of d.stairs) {
    const [x, y] = unkey(k);
    const [dx, dy] = DIRS[dir];
    const sideQ = (nx, ny, side) => ({ N: [2, 3], S: [0, 1], E: [1, 3], W: [0, 2] }[side]).map(i => quarter(nx, ny, i));
    const one = (qs) => (isVal(qs[0]) && isVal(qs[1]) && qs[0].f === qs[1].f) ? qs[0].f : null;
    const front = one(sideQ(x - dx, y - dy, dir)), hi = one(sideQ(x + dx, y + dy, OPP[dir]));
    const set = d.stairLevels.has(k) ? d.stairLevels.get(k) : null;
    const lo = set != null ? set : front;
    const info = { x, y, dir, lo, hi, set: set != null, kind: null, airlock: bounds.get(k) === 'door', cut: d.cuts.get(k) || null };
    stairInfo.push(info);
    if (set != null && front != null && front !== set) warn('check', x + 0.5, y + 0.5, `Stairs: the bottom step is set to ${fmt(set)} but the tile in front (${OPP[dir]}) is floor ${fmt(front)}`);
    if (lo === null) { warn('error', x + 0.5, y + 0.5, `Stairs: the low side (${OPP[dir]}) isn't one floor level`); continue; }
    if (hi === null) { warn('error', x + 0.5, y + 0.5, `Stairs: the high side (${dir}) isn't one floor level`); continue; }
    if (lo === hi) { warn('error', x + 0.5, y + 0.5, `Stairs with both ends on floor ${fmt(lo)}`); continue; }
    if (hi < lo) { warn('error', x + 0.5, y + 0.5, `Stairs rise ${dir} but the top (${fmt(hi)}) is lower than the bottom (${fmt(lo)})`); continue; }
    if (hi - lo > MAX_STEP) warn('error', x + 0.5, y + 0.5, `Stairs step of ${hi - lo} levels (more than ${MAX_STEP})`);
    info.kind = stairKind(hi - lo);
  }
  for (const k of d.stairLevels.keys()) if (!d.stairs.has(k)) { const [x, y] = unkey(k); warn('check', x + 0.5, y + 0.5, 'A set bottom step on a tile that is no longer stairs (ignored; the eraser drops it)'); }

  // 4. doors between two different floor levels (check)
  for (const [k, kind] of bounds) {
    if (kind !== 'door' || d.cuts.has(k) || !look.has(k)) continue;
    const [x, y] = unkey(k);
    for (const [[ax, ay, aq], [bx, by, bq]] of [[[x - 1, y, 1], [x + 1, y, 0]], [[x, y - 1, 2], [x, y + 1, 0]]]) {
      const a = quarter(ax, ay, aq), b = quarter(bx, by, bq);
      if (isVal(a) && isVal(b) && a.f !== b.f) { warn('check', x + 0.5, y + 0.5, `Door between floor ${fmt(a.f)} and ${fmt(b.f)}`); break; }
    }
  }

  // 5. corners: different floors touching only diagonally (check)
  const corners = new Set();
  for (const k of look) { const [x, y] = unkey(k); corners.add(key(x, y)); corners.add(key(x + 1, y)); corners.add(key(x, y + 1)); corners.add(key(x + 1, y + 1)); }
  for (const k of corners) {
    const [cx, cy] = unkey(k);
    const bl = quarter(cx - 1, cy - 1, 3), br = quarter(cx, cy - 1, 2), tl = quarter(cx - 1, cy, 1), tr = quarter(cx, cy, 0);
    const open = (v) => !isVal(v);
    if (isVal(bl) && isVal(tr) && bl.f !== tr.f && open(br) && open(tl)) warn('check', cx, cy, `Floor ${fmt(bl.f)} and ${fmt(tr.f)} touch only at a corner`);
    else if (isVal(br) && isVal(tl) && br.f !== tl.f && open(bl) && open(tr)) warn('check', cx, cy, `Floor ${fmt(br.f)} and ${fmt(tl.f)} touch only at a corner`);
  }

  return { quarter, warnings, stubs, cutLines, stairInfo, errEdges, manual, regionsOf };
}

// ---------------------------------------------------------------- the tool
export function createLevels(env) {
  // env: { pane, getScene, getRenderer, gridLocal, gridWorld, setGridXf, camScale, redraw, jumpTo, toast,
  //        download, mapSource, mapKey, getArea, setTool, isActive, safeName, lsGet, lsSet }
  const doc = new LevelsDoc();
  const ui = { mode: 'paint', layer: 'floor', level: 1, shape: 'ns', autoJoin: false, stairDir: 'auto', brush: 1, show: true, onlyMarks: false };
  let analysis = new Map();
  let cache = { scene: null, map: new Map() };
  let mapSha1 = null, fileNote = '';
  let drag = null, hover = null, altDown = false;

  const sceneCache = (k, make) => {
    const scene = env.getScene();
    if (cache.scene !== scene) cache = { scene, map: new Map() };
    if (!cache.map.has(k)) cache.map.set(k, make(scene));
    return cache.map.get(k);
  };
  const tilesOf = (uid) => sceneCache('t|' + uid, (scene) => {
    const s = new Set();
    for (const t of (scene ? (scene.tiles.get(+uid) || scene.tiles.get(uid) || []) : [])) s.add(key(t.x, t.y));
    return s;
  });
  // boundary tiles as the importer finds them: door beats window beats wall; a windoor with a table is a door
  const boundsOf = (uid) => sceneCache('b|' + uid, (scene) => {
    const kinds = new Map(), table = new Set(), windoor = new Set();
    if (scene) for (const it of scene.items) {
      if (it.kind !== 'ent' || String(it.grid) !== String(uid)) continue;
      const k = key(Math.floor(it.x), Math.floor(it.y)), n = String(it.proto || '').toLowerCase();
      const kind = protoKind(n);
      if (n.includes('table')) table.add(k);
      if (n.includes('windoor')) windoor.add(k);
      if (!kind || kind === 'thin') continue;
      if (!kinds.has(k)) kinds.set(k, new Set());
      kinds.get(k).add(kind);
    }
    const out = new Map();
    for (const [k, set] of kinds) out.set(k, set.has('door') ? 'door' : set.has('window') ? 'window' : 'wall');
    for (const k of windoor) if (table.has(k)) out.set(k, 'door');
    return out;
  });

  function reanalyse() {
    analysis = new Map();
    for (const [uid, d] of doc.grids) if (!d.empty) analysis.set(uid, analyse(d, tilesOf(uid), boundsOf(uid)));
  }
  // after every edit: everything is worked out again for the whole grid, saved locally, redrawn
  function changed() {
    reanalyse();
    try { if (env.mapSource()) env.lsSet('levels2.' + env.mapKey(), doc.serialize()); } catch (e) { /* ignore */ }
    renderPane();
    env.redraw();
  }

  function gridAt(wx, wy) {
    const R = env.getRenderer();
    if (!R.grids) return null;
    let best = null;
    for (const gr of R.grids.values()) {
      if (!isFinite(gr.minX)) continue;
      const [lx, ly] = env.gridLocal(gr, wx, wy);
      if (tilesOf(String(gr.uid)).has(key(Math.floor(lx), Math.floor(ly)))) return { gr, uid: String(gr.uid), lx, ly };
      if (!best && lx >= gr.minX && lx <= gr.maxX && ly >= gr.minY && ly <= gr.maxY) best = { gr, uid: String(gr.uid), lx, ly };
    }
    if (best) return best;
    const area = env.getArea();
    const gr = R.grids.get(area && area.grid != null ? area.grid : [...R.grids.keys()][0]);
    if (!gr) return null;
    const [lx, ly] = env.gridLocal(gr, wx, wy);
    return { gr, uid: String(gr.uid), lx, ly };
  }
  const tileOf = (h) => [Math.floor(h.lx), Math.floor(h.ly)];
  const quarterAt = (h) => { const [x, y] = tileOf(h); return (h.ly - y >= 0.5 ? 2 : 0) + (h.lx - x >= 0.5 ? 1 : 0); };
  const nearestSide = (h) => {
    const [x, y] = tileOf(h), fx = h.lx - x, fy = h.ly - y;
    const dist = { w: fx, e: 1 - fx, s: fy, n: 1 - fy };
    return Object.keys(dist).reduce((p, q) => dist[p] <= dist[q] ? p : q);
  };

  // ---- edits
  const regionOf = (d, k, qi) => {
    const A = armsOf(d.cuts.get(k)), parent = [0, 1, 2, 3];
    const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (const a of ['n', 'e', 's', 'w']) if (!A.has(a)) { const [p, q] = ARM_SEP[a]; parent[find(p)] = find(q); }
    return [0, 1, 2, 3].filter(i => find(i) === find(qi));
  };
  function setRegion(d, k, qi, field, value) {
    const reg = regionOf(d, k, qi), o = d.cutLevels.get(k) || {};
    for (const i of reg) {
      const q = QNAMES[i];
      o[q] = o[q] || {};
      if (value == null) delete o[q][field]; else o[q][field] = value;
      if (o[q].floor == null && o[q].roof == null) delete o[q];
    }
    if (Object.keys(o).length) d.cutLevels.set(k, o); else d.cutLevels.delete(k);
  }
  function paintTile(d, x, y, v) { (ui.layer === 'floor' ? d.floor : d.roof).set(key(x, y), v); }
  function paintAt(h) {
    const d = doc.g(h.uid), [x0, y0] = tileOf(h), k0 = key(x0, y0);
    if (ui.brush === 1) {
      // on a cut tile: the part under the cursor, by hand; on stairs: the bottom step
      if (d.stairs.has(k0)) { if (ui.layer === 'floor') d.stairLevels.set(k0, ui.level); return; }
      if (d.cuts.has(k0)) { setRegion(d, k0, quarterAt(h), ui.layer, ui.level); return; }
    }
    const r = (ui.brush - 1) / 2;
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) {
      const k = key(x, y);
      if (!d.cuts.has(k) && !d.stairs.has(k)) paintTile(d, x, y, ui.level);
    }
  }
  function placeCut(d, x, y) {
    const k = key(x, y);
    const set = armsOf(ui.shape);
    if (ui.autoJoin) {
      // join only to cut tiles and stairs, never to walls, windows, doors or plain tiles
      const ARMDIR = { n: [0, 1], s: [0, -1], w: [-1, 0], e: [1, 0] }, OPPA = { n: 's', s: 'n', w: 'e', e: 'w' };
      for (const a of ['n', 's', 'w', 'e']) {
        const [dx, dy] = ARMDIR[a], nk = key(x + dx, y + dy);
        if (d.stairs.has(nk)) set.add(a);
        else if (d.cuts.has(nk)) { set.add(a); d.cuts.set(nk, canonArms(d.cuts.get(nk) + OPPA[a])); }
      }
    }
    d.cuts.set(k, canonArms([...set].join('')));
  }
  function toggleArm(h) {
    const d = doc.g(h.uid), [x, y] = tileOf(h), k = key(x, y);
    if (!d.cuts.has(k)) { env.toast('Alt+click a cut tile near an edge to add or remove that arm', true); return; }
    const set = armsOf(d.cuts.get(k)), a = nearestSide(h);
    if (set.has(a)) set.delete(a); else set.add(a);
    if (set.size < 2) { env.toast('A cut needs at least two arms. The eraser removes the cut.', true); return; }
    d.cuts.set(k, canonArms([...set].join('')));
  }
  function stairsAt(h, alt) {
    const d = doc.g(h.uid), [x, y] = tileOf(h), k = key(x, y);
    if (alt) { d.stairs.delete(k); d.stairLevels.delete(k); return; }
    let dir = ui.stairDir;
    if (dir === 'auto') {
      if (d.stairs.has(k)) dir = CW[d.stairs.get(k)];
      else {
        const lvl = (xx, yy) => { const kk = key(xx, yy); return (d.cuts.has(kk) || d.stairs.has(kk) || boundsOf(h.uid).has(kk) || !(tilesOf(h.uid).has(kk) || d.floor.has(kk))) ? null : (d.floor.get(kk) || 0); };
        let best = 'N', bestStep = -Infinity;
        for (const s of ['N', 'E', 'S', 'W']) {
          const [dx, dy] = DIRS[s], hi = lvl(x + dx, y + dy), lo = lvl(x - dx, y - dy);
          if (hi === null || lo === null) continue;
          if (hi - lo > bestStep) { bestStep = hi - lo; best = s; }
        }
        dir = best;
      }
    }
    d.stairs.set(k, dir);
  }
  // the eraser: cut tile (with its hand-set parts), stairs (with its bottom step), edge cuts, and the
  // tile's level in the current layer (back to unassigned)
  function eraseAt(h) {
    const d = doc.g(h.uid), [x, y] = tileOf(h), k = key(x, y);
    d.cuts.delete(k); d.cutLevels.delete(k); d.stairs.delete(k); d.stairLevels.delete(k);
    for (const s of ['N', 'E', 'S', 'W']) d.edges.delete(edgeKey(x, y, s));
    (ui.layer === 'floor' ? d.floor : d.roof).delete(k);
  }
  function edgeAt(h) {
    const d = doc.g(h.uid), [x, y] = tileOf(h), side = nearestSide(h).toUpperCase();
    const ek = edgeKey(x, y, side);
    if (d.edges.has(ek)) d.edges.delete(ek); else d.edges.add(ek);
  }
  // put a hand-set part back to worked out (current layer); on stairs, the bottom step
  function clearPart(h) {
    const d = doc.g(h.uid), [x, y] = tileOf(h), k = key(x, y);
    if (d.stairs.has(k)) { if (!d.stairLevels.has(k)) return false; d.stairLevels.delete(k); return true; }
    if (d.cuts.has(k)) { setRegion(d, k, quarterAt(h), ui.layer, null); return true; }
    return false;
  }
  function clearAt(wx, wy) {
    const h = gridAt(wx, wy);
    if (!h) return;
    doc.snapshot();
    if (clearPart(h)) changed(); else doc.undoStack.pop();
  }

  // ---- pointer (called by app.js while the Levels tool is active)
  function down(wx, wy, e) {
    const h = gridAt(wx, wy);
    if (!h) return;
    doc.snapshot();
    const d = doc.g(h.uid), [x, y] = tileOf(h);
    if (ui.mode === 'paint') {
      if (e.shiftKey) { drag = { kind: 'rect', uid: h.uid, gr: h.gr, a: [h.lx, h.ly], b: [h.lx, h.ly] }; env.redraw(); return; }
      drag = { kind: 'paint', uid: h.uid }; paintAt(h);
    } else if (ui.mode === 'cut') {
      if (e.altKey) { toggleArm(h); drag = null; }
      else { placeCut(d, x, y); drag = { kind: 'cut', uid: h.uid, last: key(x, y) }; }
    } else if (ui.mode === 'clear') { clearPart(h); drag = null; }
    else if (ui.mode === 'edge') { edgeAt(h); drag = null; }
    else if (ui.mode === 'stairs') { stairsAt(h, e.altKey); drag = null; }
    else if (ui.mode === 'erase') { drag = { kind: 'erase', uid: h.uid }; eraseAt(h); }
    changed();
  }
  function move(wx, wy) {
    const h = gridAt(wx, wy);
    hover = h ? { uid: h.uid, gr: h.gr, x: Math.floor(h.lx), y: Math.floor(h.ly), lx: h.lx, ly: h.ly } : null;
    showHover();
    if (!drag) { env.redraw(); return; }
    if (!h || h.uid !== drag.uid) return;
    if (drag.kind === 'rect') { drag.b = [h.lx, h.ly]; env.redraw(); return; }
    if (drag.kind === 'paint') paintAt(h);
    else if (drag.kind === 'cut') {
      // the chosen shape on every tile the drag passes over (four-way steps, no gaps), nothing else
      const d = doc.g(h.uid), k = key(Math.floor(h.lx), Math.floor(h.ly));
      if (k === drag.last) return;
      let [x, y] = unkey(drag.last);
      const [tx, ty] = unkey(k);
      let guard = 0;
      while ((x !== tx || y !== ty) && guard++ < 200) {
        if (Math.abs(tx - x) >= Math.abs(ty - y)) x += Math.sign(tx - x); else y += Math.sign(ty - y);
        placeCut(d, x, y);
      }
      drag.last = k;
    } else if (drag.kind === 'erase') eraseAt(h);
    changed();
  }
  function up() {
    if (drag && drag.kind === 'rect') {
      const d = doc.g(drag.uid);
      const x0 = Math.floor(Math.min(drag.a[0], drag.b[0])), x1 = Math.floor(Math.max(drag.a[0], drag.b[0]));
      const y0 = Math.floor(Math.min(drag.a[1], drag.b[1])), y1 = Math.floor(Math.max(drag.a[1], drag.b[1]));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 250000) {
        const tiles = tilesOf(drag.uid), bounds = boundsOf(drag.uid);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const k = key(x, y);
          if (d.cuts.has(k) || d.stairs.has(k)) continue;
          if (tiles.has(k) && !bounds.has(k)) paintTile(d, x, y, ui.level);
        }
      } else env.toast('That area is too large', true);
      drag = null;
      changed();
      return;
    }
    drag = null;
  }
  function leave() { hover = null; showHover(); env.redraw(); }
  function onKey(k) {
    if (k === 'r' && ui.mode === 'cut') { ui.shape = rotateShape(ui.shape); renderPane(); env.redraw(); return true; }
    return false;
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && !altDown) { altDown = true; if (env.isActive()) env.redraw(); } });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') { altDown = false; if (env.isActive()) env.redraw(); } });

  function applyToArea() {
    const a = env.getArea();
    if (!a || !a.tiles || !a.tiles.size) { env.toast('Select an area first (Pick tool, drag; or a room in the Area tab)', true); return; }
    doc.snapshot();
    const d = doc.g(a.grid), bounds = boundsOf(String(a.grid));
    let n = 0;
    for (const k of a.tiles) { if (d.cuts.has(k) || d.stairs.has(k) || bounds.has(k)) continue; const [x, y] = unkey(k); paintTile(d, x, y, ui.level); n++; }
    changed();
    env.toast(`${ui.layer === 'floor' ? 'Floor' : 'Roof'} ${fmt(ui.level)} set on ${n} floor tiles`);
  }

  function showHover() {
    const el = env.pane && env.pane.querySelector('#lvHover');
    if (!el) return;
    if (!hover) { el.textContent = 'Point at a tile to read its levels.'; return; }
    const d = doc.grids.get(hover.uid), an = analysis.get(hover.uid), k = key(hover.x, hover.y);
    const bk = boundsOf(hover.uid).get(k);
    let t = `Tile ${hover.x}, ${hover.y}`;
    if (d && d.stairs.has(k)) {
      const info = an && an.stairInfo.find(i => i.x === hover.x && i.y === hover.y);
      t += `: stairs rising ${d.stairs.get(k)}` + (info ? `, bottom ${info.lo != null ? fmt(info.lo) : '?'}${info.set ? ' (set)' : ''}, top ${info.hi != null ? fmt(info.hi) : '?'}${info.kind ? ` (${info.kind.name})` : ''}${info.cut ? `, cut through (${info.cut})` : ''}` : '');
    } else if (d && d.cuts.has(k) && an) {
      const qi = (hover.ly - hover.y >= 0.5 ? 2 : 0) + (hover.lx - hover.x >= 0.5 ? 1 : 0);
      const v = an.quarter(hover.x, hover.y, qi), m = an.manual.get(k)[qi];
      t += `: cut ${d.cuts.get(k)}, part ${QNAMES[qi]}` + (v ? `: floor ${fmt(v.f)}${m.floor !== false ? ' (set)' : ''}, roof ${fmt(v.r)}${m.roof !== false ? ' (set)' : ''}, absolute roof ${fmt(v.f + v.r)}` : ': no level');
    } else if (bk) t += `: ${bk} (no level; cut in half by the importer)`;
    else if (!tilesOf(hover.uid).has(k) && !(d && d.floor.has(k))) t += ': no floor';
    else {
      const f = (d && d.floor.get(k)) || 0, r = (d && d.roof.get(k)) || 0;
      const fa = d && d.floor.has(k), ra = d && d.roof.has(k);
      t += `: floor ${fmt(f)}${fa ? '' : ' (unassigned)'}, roof ${fmt(r)}${ra ? '' : ' (unassigned)'}, absolute roof ${fmt(f + r)}`;
    }
    el.textContent = t;
  }

  // ---- drawing (in app.js's overlay, world space per grid)
  function text(g, s, str, x, y, color, size) {
    g.save(); g.translate(x, y); g.scale(1 / s, -1 / s);
    g.font = `bold ${Math.max(9, Math.min(13, s * (size || 0.26)))}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeText(str, 0, 0);
    g.fillStyle = color; g.fillText(str, 0, 0);
    g.restore();
  }
  function draw(g) {
    const R = env.getRenderer();
    if (!R.grids) return;
    const s = env.camScale();
    for (const [uid, d] of doc.grids) {
      const gr = R.grids.get(+uid) || R.grids.get(uid);
      if (!gr || !ui.show) continue;
      const an = analysis.get(uid);
      g.save();
      env.setGridXf(g, gr);
      if (!ui.onlyMarks) {
        // the chosen layer's colours; cut parts solid when set by hand, faint and hatched when worked out
        const solid = new Map(), faint = new Map();
        const add = (m, c, x, y, w, h) => { if (!m.has(c)) m.set(c, new Path2D()); m.get(c).rect(x, y, w, h); };
        for (const [k, v] of (ui.layer === 'floor' ? d.floor : d.roof)) {
          if (d.cuts.has(k) || d.stairs.has(k)) continue;
          const [x, y] = unkey(k); add(solid, levelColor(v), x, y, 1, 1);
        }
        const hatchLines = new Path2D();
        if (an) for (const k of d.cuts.keys()) {
          const [x, y] = unkey(k), man = an.manual.get(k);
          [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]].forEach(([ox, oy], i) => {
            const v = an.quarter(x, y, i);
            if (!v || typeof v !== 'object') return;
            const val = ui.layer === 'floor' ? v.f : v.r;
            if (man && man[i][ui.layer] !== false) add(solid, levelColor(val), x + ox, y + oy, 0.5, 0.5);
            else {
              add(faint, levelColor(val), x + ox, y + oy, 0.5, 0.5);
              for (let t = 0.125; t < 1; t += 0.25) { hatchLines.moveTo(x + ox + Math.max(0, t - 0.5), y + oy + Math.min(0.5, t)); hatchLines.lineTo(x + ox + Math.min(0.5, t), y + oy + Math.max(0, t - 0.5)); }
            }
          });
        }
        g.globalAlpha = 0.42;
        for (const [c, p] of solid) { g.fillStyle = c; g.fill(p); }
        g.globalAlpha = 0.18;
        for (const [c, p] of faint) { g.fillStyle = c; g.fill(p); }
        g.globalAlpha = 0.45; g.strokeStyle = '#ffffff'; g.lineWidth = 1 / s; g.stroke(hatchLines);
        g.globalAlpha = 1;
      }
      // stairs
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
        // a set bottom step: a bar in its level colour at the low end
        if (info && info.set) {
          const [dx, dy] = DIRS[dir];
          g.fillStyle = levelColor(info.lo);
          if (dx) g.fillRect(x + (dx > 0 ? 0.06 : 0.82), y + 0.08, 0.12, 0.84); else g.fillRect(x + 0.08, y + (dy > 0 ? 0.06 : 0.82), 0.84, 0.12);
        }
        if (s >= 18) {
          const label = (info && info.kind ? info.kind.label : '?') + (info && info.airlock ? ' · airlock' : '') + (info && info.cut ? ' · cut' : '');
          text(g, s, label, x + 0.5 + { N: 0, S: 0, E: -0.3, W: 0.3 }[dir], y + 0.5 + { N: -0.33, S: 0.33, E: 0, W: 0 }[dir], '#fff');
        }
      }
      if (an) {
        g.strokeStyle = '#ff2bd6'; g.lineWidth = Math.max(2.5, s * 0.07) / s; g.lineCap = 'round';
        g.beginPath();
        for (const [x0, y0, x1, y1] of an.cutLines) { g.moveTo(x0, y0); g.lineTo(x1, y1); }
        g.stroke();
        // stubs: floor = cyan bar on the lower floor's side, roof = orange outline on the higher roof's side
        for (const st of an.stubs) {
          const off = st.kind === 'floor' ? 0.1 : 0.2, len = st.len || 0.5, th = 0.08;
          const sgn = (st.side === 'E' || st.side === 'N') ? 1 : -1;
          let rx, ry, rw, rh;
          if (st.ax === 'v') { rx = st.x + sgn * off - th / 2; ry = st.y - len / 2; rw = th; rh = len; }
          else { rx = st.x - len / 2; ry = st.y + sgn * off - th / 2; rw = len; rh = th; }
          if (st.kind === 'floor') { g.fillStyle = '#3fe0ff'; g.fillRect(rx, ry, rw, rh); }
          else { g.strokeStyle = '#ff9a3b'; g.lineWidth = 1.5 / s; g.strokeRect(rx, ry, rw, rh); }
          if (s >= 36) text(g, s, String(st.h), rx + rw / 2 + (st.ax === 'v' ? sgn * 0.09 : 0), ry + rh / 2 + (st.ax === 'h' ? sgn * 0.09 : 0), st.kind === 'floor' ? '#3fe0ff' : '#ff9a3b', 0.18);
        }
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
      g.restore();
    }
    if (drag && drag.kind === 'rect') {
      g.save(); env.setGridXf(g, drag.gr);
      const x0 = Math.floor(Math.min(drag.a[0], drag.b[0])), x1 = Math.floor(Math.max(drag.a[0], drag.b[0])) + 1;
      const y0 = Math.floor(Math.min(drag.a[1], drag.b[1])), y1 = Math.floor(Math.max(drag.a[1], drag.b[1])) + 1;
      g.fillStyle = levelColor(ui.level); g.globalAlpha = 0.25; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.globalAlpha = 1;
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 / s; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
    } else if (hover && env.isActive()) {
      g.save(); env.setGridXf(g, hover.gr);
      g.lineWidth = 2 / s;
      const x = hover.x, y = hover.y, d = doc.grids.get(hover.uid), k = key(x, y);
      const END = { n: [0.5, 1], s: [0.5, 0], w: [0, 0.5], e: [1, 0.5] };
      if (ui.mode === 'edge') {
        const side = nearestSide(hover);
        g.strokeStyle = '#ff2bd6'; g.beginPath();
        if (side === 'w') { g.moveTo(x, y); g.lineTo(x, y + 1); } else if (side === 'e') { g.moveTo(x + 1, y); g.lineTo(x + 1, y + 1); }
        else if (side === 's') { g.moveTo(x, y); g.lineTo(x + 1, y); } else { g.moveTo(x, y + 1); g.lineTo(x + 1, y + 1); }
        g.stroke();
      } else if (ui.mode === 'cut' && altDown) {
        const e = END[nearestSide(hover)];
        g.strokeStyle = '#ff2bd6'; g.setLineDash([3 / s, 3 / s]); g.beginPath();
        g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + e[0], y + e[1]); g.stroke(); g.setLineDash([]);
      } else if (ui.mode === 'cut') {
        g.strokeStyle = 'rgba(255,43,214,.6)'; g.lineWidth = Math.max(2.5, s * 0.07) / s; g.beginPath();
        for (const a of ui.shape) { g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + END[a][0], y + END[a][1]); }
        g.stroke();
        g.strokeStyle = '#ff2bd6'; g.lineWidth = 1.5 / s; g.strokeRect(x, y, 1, 1);
      } else if (((ui.mode === 'paint' && ui.brush === 1) || ui.mode === 'clear') && d && d.cuts.has(k) && !d.stairs.has(k)) {
        const qi = (hover.ly - y >= 0.5 ? 2 : 0) + (hover.lx - x >= 0.5 ? 1 : 0);
        g.strokeStyle = ui.mode === 'clear' ? '#ffffff' : levelColor(ui.level);
        for (const i of regionOf(d, k, qi)) g.strokeRect(x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5);
      } else {
        const r = ui.mode === 'paint' ? (ui.brush - 1) / 2 : 0;
        g.strokeStyle = ui.mode === 'paint' ? levelColor(ui.level) : ui.mode === 'erase' ? '#ffffff' : '#ff2bd6';
        g.strokeRect(x - r, y - r, 1 + 2 * r, 1 + 2 * r);
      }
      g.restore();
    }
  }

  // ---- files
  function mapBaseName() {
    const src = env.mapSource();
    return String((src && src.name) || 'map').split('/').pop().replace(/\.ya?ml$/i, '');
  }
  async function save() {
    const src = env.mapSource();
    if (!src) { env.toast('Open a map first', true); return; }
    reanalyse();
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
    try { doc.snapshot(); doc.fromFile(j); } catch (e) { env.toast('Could not read the levels file: ' + e.message, true); return true; }
    const src = env.mapSource();
    const sha = mapSha1 || (mapSha1 = await sha1(src.text));
    fileNote = '';
    if (j.map_sha1 && sha && j.map_sha1 !== sha) fileNote = `${name || 'This file'} was made for a different version of the map (its SHA-1 doesn't match). Check the cuts and stairs.`;
    else if (j.map && j.map.toLowerCase() !== String(src.name || '').split('/').pop().toLowerCase()) fileNote = `${name || 'This file'} was made for ${j.map}.`;
    if (j.version === 1) fileNote = (fileNote ? fileNote + ' ' : '') + 'Read as a version 1 file: levels in metres became floor levels, roofs are 0. Saving writes version 2.';
    changed();
    env.toast(fileNote || 'Levels loaded', !!fileNote);
    return true;
  }

  async function mapLoaded() {
    doc.grids = new Map(); doc.undoStack = []; doc.redoStack = [];
    fileNote = ''; mapSha1 = null;
    const saved = env.lsGet('levels2.' + env.mapKey()) || env.lsGet('levels.' + env.mapKey());
    if (saved) doc.restore(saved);
    const src = env.mapSource();
    if (src) sha1(src.text).then(s => { mapSha1 = s; });
    reanalyse();
    renderPane();
  }
  function sceneReady() { cache = { scene: null, map: new Map() }; reanalyse(); renderPane(); env.redraw(); }

  // ---- the pane
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderPane() {
    const p = env.pane;
    if (!p) return;
    const all = [];
    for (const [uid, a] of analysis) for (const w of a.warnings) all.push({ ...w, uid });
    all.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1));
    const errors = all.filter(w => w.kind === 'error').length, checks = all.length - errors;
    let nf = 0, nr = 0, cuts = 0, edges = 0, stairs = 0, set = 0, sset = 0, air = 0;
    for (const d of doc.grids.values()) { nf += d.floor.size; nr += d.roof.size; cuts += d.cuts.size; edges += d.edges.size; stairs += d.stairs.size; set += d.cutLevels.size; sset += d.stairLevels.size; }
    for (const a of analysis.values()) air += a.stairInfo.filter(i => i.airlock).length;
    const area = env.getArea();
    const L = ui.layer === 'floor' ? 'Floor' : 'Roof';
    const modeBtn = (m, label, title) => `<button class="btn small lvmode${ui.mode === m ? ' on' : ''}" data-m="${m}" title="${title}">${label}</button>`;
    const opt = (name, v, label, cur) => `<button class="btn small lvopt${cur === v ? ' on' : ''}" data-o="${name}" data-v="${v}">${label}</button>`;
    p.innerHTML = `
      <h3>Levels</h3>
      <p class="hint">Floor and roof heights for the Blender importer (1 level = 0.75 m), saved next to the map as <b>${esc(mapBaseName())}.levels.json</b>. The map itself isn't changed.</p>
      ${fileNote ? `<p class="lvnote">${esc(fileNote)}</p>` : ''}
      <div class="row gap wrap">
        <label class="tglbtn"><input type="checkbox" id="lvShow" ${ui.show ? 'checked' : ''}> Show overlay</label>
        <label class="tglbtn"><input type="checkbox" id="lvOnly" ${ui.onlyMarks ? 'checked' : ''}> Only cuts and stairs</label>
      </div>
      <h4>Layer</h4>
      <div class="row gap">${opt('layer', 'floor', 'Floor', ui.layer)}${opt('layer', 'roof', 'Roof (from the tile’s floor)', ui.layer)}</div>
      <h4>Tool</h4>
      <div class="row gap wrap">
        ${modeBtn('paint', 'Paint level', 'Drag to paint floor tiles in the chosen layer; Shift+drag paints a rectangle. With the 1×1 brush: on a cut tile it sets the part under the cursor by hand, on stairs it sets the bottom step (floor layer).')}
        ${modeBtn('cut', 'Cut tile', 'Click places the chosen shape exactly; drag places it on every tile you pass. R turns the shape. Alt+click near an edge of a cut tile adds or removes that arm.')}
        ${modeBtn('clear', 'Clear set part', 'Click a part of a cut tile to put it back to worked out (this layer), or stairs to unset the bottom step. Right-click does the same in any mode.')}
        ${modeBtn('edge', 'Edge cut', 'Click next to a tile edge to cut exactly on that edge (or remove it).')}
        ${modeBtn('stairs', 'Stairs', 'Click a tile to make it stairs. Auto points them uphill; clicking again turns them. Alt+click removes. To cut through stairs, place a cut tile on them.')}
        ${modeBtn('erase', 'Eraser', 'Drag to remove cut tiles, stairs and edge cuts, and to unassign the level in this layer.')}
      </div>
      ${ui.mode === 'cut' ? `
      <h4>Cut shape <span class="lvcount">R turns it</span></h4>
      <div class="lvshapes">${SHAPES.map(([grp, list]) => `<div class="lvsgrp"><small>${grp}</small><div>${list.map(sh => `<button class="lvshape${ui.shape === sh ? ' on' : ''}" data-s="${sh}" title="${sh}">${shapeSvg(sh)}</button>`).join('')}</div></div>`).join('')}</div>
      <label class="row tglbtn" title="When on, a placed cut tile also joins neighbouring cut tiles and stairs (never walls, windows, doors or plain tiles)"><input type="checkbox" id="lvJoin" ${ui.autoJoin ? 'checked' : ''}> Join to neighbouring cuts and stairs</label>` : ''}
      <h4>${L} level</h4>
      <div class="lvlevels">${LEVELS.map(v => `<button class="lvlv${ui.level === v ? ' on' : ''}" data-v="${v}" style="--c:${levelColor(v)}">${v === 0 ? '0' : fmt(v)}</button>`).join('')}</div>
      <div class="row gap">
        <label class="row">Brush ${[1, 3, 5].map(b => `<button class="btn small lvbrush${ui.brush === b ? ' on' : ''}" data-b="${b}">${b}×${b}</button>`).join('')}</label>
      </div>
      <button class="btn small" id="lvArea" ${area && area.tiles && area.tiles.size ? '' : 'disabled'}>Set ${L.toLowerCase()} ${fmt(ui.level)} on the Area selection${area && area.tiles && area.tiles.size ? ` (${area.tiles.size} tiles)` : ''}</button>
      <h4>Stairs rise</h4>
      <div class="row gap">${opt('stairDir', 'auto', 'Auto', ui.stairDir)}${['N', 'E', 'S', 'W'].map(dd => opt('stairDir', dd, dd, ui.stairDir)).join('')}</div>
      <p class="lvhover" id="lvHover"></p>
      <h4>Legend</h4>
      <div class="lvlegend">
        ${LEVELS.map(v => `<span><i style="background:${levelColor(v)}"></i>${v === 0 ? '0' : fmt(v)}</span>`).join('')}
        <span><i class="unsw"></i>unassigned (counts as 0)</span>
        <span><i class="cutsw"></i>cut line</span>
        <span><i class="hatchsw"></i>cut part, worked out</span>
        <span><i class="stubf"></i>floor stub (lower floor’s side)</span>
        <span><i class="stubr"></i>roof stub (higher roof’s side)</span>
        <span><i class="errsw"></i>floors touching</span>
        <span><i class="airsw"></i>stairs in an airlock</span>
        <span>“· cut”: stairs cut through</span>
      </div>
      <p class="hint">Stairs: 1 level small, 2 steep, 3–4 a ladder. Walls, windows and doors have no level of their own.</p>
      <h4>Warnings <span class="lvcount">${errors} error${errors === 1 ? '' : 's'}, ${checks} to check</span></h4>
      <div class="lvwarn">${all.length ? all.slice(0, 300).map((w, i) => `<button class="lvw ${w.kind}" data-i="${i}">${w.kind === 'check' ? 'Check: ' : ''}${esc(w.msg)} <small>(${Math.floor(w.x)}, ${Math.floor(w.y)})</small></button>`).join('') + (all.length > 300 ? `<p class="hint">…and ${all.length - 300} more</p>` : '') : '<p class="hint">None.</p>'}</div>
      <h4>File</h4>
      <p class="hint">${nf} floor and ${nr} roof tiles assigned, ${cuts} cut tiles (${set} with parts set by hand), ${edges} edge cuts, ${stairs} stairs${sset ? ` (${sset} with a set bottom step)` : ''}${air ? `, ${air} in an airlock` : ''}.</p>
      <div class="row gap wrap">
        <button class="btn primary small" id="lvSave">Save .levels.json</button>
        <button class="btn small" id="lvOpen">Open .levels.json</button>
        <button class="btn small" id="lvClear">Clear all</button>
        <input type="file" id="lvFile" accept=".json,application/json" hidden>
      </div>`;
    p.querySelector('#lvShow').onchange = (e) => { ui.show = e.target.checked; env.redraw(); };
    p.querySelector('#lvOnly').onchange = (e) => { ui.onlyMarks = e.target.checked; env.redraw(); };
    p.querySelectorAll('.lvmode').forEach(b => b.onclick = () => { ui.mode = b.dataset.m; env.setTool('levels'); renderPane(); });
    p.querySelectorAll('.lvopt').forEach(b => b.onclick = () => { ui[b.dataset.o] = b.dataset.v; renderPane(); env.redraw(); });
    p.querySelectorAll('.lvshape').forEach(b => b.onclick = () => { ui.shape = b.dataset.s; ui.mode = 'cut'; env.setTool('levels'); renderPane(); });
    const join = p.querySelector('#lvJoin'); if (join) join.onchange = (e) => { ui.autoJoin = e.target.checked; };
    p.querySelectorAll('.lvlv').forEach(b => b.onclick = () => { ui.level = +b.dataset.v; if (ui.mode !== 'paint') ui.mode = 'paint'; env.setTool('levels'); renderPane(); });
    p.querySelectorAll('.lvbrush').forEach(b => b.onclick = () => { ui.brush = +b.dataset.b; renderPane(); });
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
    showHover();
  }

  return {
    down, move, up, leave, draw, mapLoaded, sceneReady, loadFile, loadJson, renderPane, clearAt, key: onKey,
    undo() { if (doc.undo()) changed(); }, redo() { if (doc.redo()) changed(); },
    get doc() { return doc; },
  };
}
