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

import { tileEyes, seenFrom } from './roomvis.js?v=3';
import { eyePolygon, blockerCorners, tileKey } from './fov-view.js?v=72';
import { exportSelection } from './exportsel.js?v=2';

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
// per quarter, its two outside neighbours: [dx, dy, quarter of that tile]
const OUTER_Q = [[[0, -1, 2], [-1, 0, 1]], [[0, -1, 3], [1, 0, 0]], [[0, 1, 0], [-1, 0, 3]], [[0, 1, 1], [1, 0, 2]]];
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
    this.subCuts = new Set();       // cut tiles that are subcuts (visual height steps inside one room)
    this.subEdges = new Set();      // edge-cut halves that are subcuts
    this.roomNames = new Map();     // "x,y#q" (a quarter of a tile in the room) -> room name
    this.spaceTiles = new Set();    // "x,y" tiles with no floor (space, lattice) added to rooms by hand
    this.noHull = new Set();        // "x,y#q" anchors of rooms that aren't part of the hull
    this.dots = new Set();          // "X,Y" half-tile lattice points marked by the dot tool, not joined yet
  }
  get empty() { return !this.floor.size && !this.roof.size && !this.cuts.size && !this.edges.size && !this.stairs.size && !this.cutLevels.size && !this.stairLevels.size && !this.roomNames.size && !this.spaceTiles.size && !this.noHull.size && !this.dots.size; }
}
// an edge is stored once, as E or N of a tile
function edgeKey(x, y, side) {
  if (side === 'W') { x -= 1; side = 'E'; }
  if (side === 'S') { y -= 1; side = 'N'; }
  return x + ',' + y + ',' + side;
}
// edge cuts are kept per half edge: "<edge>#0" / "<edge>#1". On an E edge 0 is the south half and 1 the
// north half; on an N edge 0 is the west half and 1 the east half. A full edge cut is both halves.
const HALF_NAME = { E: ['S', 'N'], N: ['W', 'E'] };
const halvesOf = (edges) => {        // -> Map edge -> [bool, bool]
  const m = new Map();
  for (const h of edges) { const i = h.lastIndexOf('#'), ek = h.slice(0, i); if (!m.has(ek)) m.set(ek, [false, false]); m.get(ek)[+h.slice(i + 1)] = true; }
  return m;
};

export class LevelsDoc {
  constructor() { this.grids = new Map(); this.undoStack = []; this.redoStack = []; }
  g(uid) { uid = String(uid); if (!this.grids.has(uid)) this.grids.set(uid, new GridLevels()); return this.grids.get(uid); }
  serialize() {
    const out = {};
    for (const [uid, d] of this.grids) {
      if (d.empty) continue;
      out[uid] = { floor: [...d.floor], roof: [...d.roof], cuts: [...d.cuts], edges: [...d.edges], stairs: [...d.stairs], cutLevels: [...d.cutLevels], stairLevels: [...d.stairLevels], subCuts: [...d.subCuts], subEdges: [...d.subEdges], roomNames: [...d.roomNames], spaceTiles: [...d.spaceTiles], noHull: [...d.noHull], dots: [...d.dots] };
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
      d.edges = new Set((s.edges || []).flatMap(e => e.includes('#') ? [e] : [e + '#0', e + '#1'])); d.stairs = new Map(s.stairs || []);
      d.cutLevels = new Map(s.cutLevels || []); d.stairLevels = new Map(s.stairLevels || []);
      d.subCuts = new Set(s.subCuts || []); d.subEdges = new Set(s.subEdges || []);
      d.roomNames = new Map(s.roomNames || []);
      d.spaceTiles = new Set(s.spaceTiles || []); d.noHull = new Set(s.noHull || []); d.dots = new Set(s.dots || []);
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
  // roomsFor(uid) -> the rooms of that grid (findRooms), written as rooms / room_parts / room_names
  toFile(mapName, mapSha1, roomsFor, keep = new Set()) {
    const grids = {};
    const sorted = (it) => [...it].sort((a, b) => { const [ax, ay] = unkey(a[0]), [bx, by] = unkey(b[0]); return ay - by || ax - bx; });
    for (const [uid, d] of this.grids) {
      if (d.empty && !keep.has(uid)) continue;
      const floor = {}, roof = {}, cuts = {}, stairs = {}, cutLevels = {}, stairLevels = {};
      for (const [k, v] of sorted(d.floor)) floor[k] = v;
      for (const [k, v] of sorted(d.roof)) roof[k] = v;
      const subcuts = {};
      for (const [k, v] of sorted(d.cuts)) (d.subCuts.has(k) ? subcuts : cuts)[k] = v;
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
      const edges = [];
      for (const [ek, hv] of halvesOf(d.edges)) {
        const p = ek.split(','), sub = hv.map((on, i) => on && d.subEdges.has(ek + '#' + i));
        const mk = (half, isSub) => { const e = { x: +p[0], y: +p[1], side: p[2] }; if (half != null) e.half = HALF_NAME[p[2]][half]; if (isSub) e.sub = true; return e; };
        if (hv[0] && hv[1] && sub[0] === sub[1]) edges.push(mk(null, sub[0]));
        else for (let i = 0; i < 2; i++) if (hv[i]) edges.push(mk(i, sub[i]));
      }
      edges.sort((a, b) => a.y - b.y || a.x - b.x || (a.side < b.side ? -1 : 1) || String(a.half || '').localeCompare(String(b.half || '')));
      grids[uid] = { floor, roof, cuts, edges, stairs };
      if (Object.keys(subcuts).length) grids[uid].subcuts = subcuts;
      if (Object.keys(cutLevels).length) grids[uid].cut_levels = cutLevels;
      if (Object.keys(stairLevels).length) grids[uid].stair_levels = stairLevels;
      const R = roomsFor && roomsFor(uid);
      if (R) {
        const rooms = {}, parts = {}, names = {};
        for (const [k, id] of sorted(R.tileRoom)) rooms[k] = id;
        for (const [k, ids] of sorted(R.partRoom)) { const o = {}; ids.forEach((id, i) => { if (id != null) o[QNAMES[i]] = id; }); parts[k] = o; }
        for (const r of R.list) if (r.name) names[r.id] = r.name;
        grids[uid].rooms = rooms;
        if (Object.keys(parts).length) grids[uid].room_parts = parts;
        if (Object.keys(names).length) grids[uid].room_names = names;
        const noHull = R.list.filter(r => r.noHull).map(r => r.id);
        if (noHull.length) grids[uid].room_no_hull = noHull;
        const space = [...R.space];
        if (space.length) grids[uid].room_space_tiles = sorted(space.map(k => [k])).map(a => a[0]);
      }
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
      for (const [k, v] of Object.entries(s.cuts || {})) { const a = canonArms(v); if (a.length >= 1 && a.length === String(v).length) d.cuts.set(k, a); }
      for (const [k, v] of Object.entries(s.subcuts || {})) { const a = canonArms(v); if (a.length >= 1 && a.length === String(v).length) { d.cuts.set(k, a); d.subCuts.add(k); } }
      for (const e of (s.edges || [])) {
        if (!DIRS[e.side]) continue;
        const ek = edgeKey(+e.x, +e.y, e.side), side = ek.split(',')[2];
        if (!e.half) { d.edges.add(ek + '#0'); d.edges.add(ek + '#1'); if (e.sub) { d.subEdges.add(ek + '#0'); d.subEdges.add(ek + '#1'); } continue; }
        // a half named from a W or S edge is the same half of the stored E or N edge
        const i = HALF_NAME[side].indexOf(String(e.half).toUpperCase());
        if (i >= 0) { d.edges.add(ek + '#' + i); if (e.sub) d.subEdges.add(ek + '#' + i); }
      }
      for (const [k, v] of Object.entries(s.stairs || {})) if (DIRS[v]) d.stairs.set(k, v);
      // room names: anchored to the first tile (or part of a tile) of that room id
      for (const [id, name] of Object.entries(s.room_names || {})) {
        if (!String(name || '').trim()) continue;
        let anchor = null;
        for (const [k, v] of Object.entries(s.rooms || {})) if (String(v) === String(id)) { anchor = k + '#0'; break; }
        if (!anchor) for (const [k, o] of Object.entries(s.room_parts || {})) {
          const qi = QNAMES.findIndex(q => o && String(o[q]) === String(id));
          if (qi >= 0) { anchor = k + '#' + qi; break; }
        }
        if (anchor) d.roomNames.set(anchor, String(name).trim());
      }
      for (const id of (s.room_no_hull || [])) {
        let anchor = null;
        for (const [k, v] of Object.entries(s.rooms || {})) if (String(v) === String(id)) { anchor = k + '#0'; break; }
        if (!anchor) for (const [k, o] of Object.entries(s.room_parts || {})) { const qi = QNAMES.findIndex(q => o && String(o[q]) === String(id)); if (qi >= 0) { anchor = k + '#' + qi; break; } }
        if (anchor) d.noHull.add(anchor);
      }
    }
  }
}

// ---------------------------------------------------------------- checking
// tiles: Set "x,y" of tiles with a floor; bounds: Map "x,y" -> 'wall'|'window'|'door' (boundary tiles).
export function analyse(d, tiles, bounds = new Map()) {
  const exists = (x, y) => { const k = key(x, y); return tiles.has(k) || d.floor.has(k) || d.cuts.has(k) || d.stairs.has(k); };
  // a cut on a wall, window, door or over space only splits rooms: that tile has no level of its own
  const roomOnly = (k) => d.cuts.has(k) && !d.stairs.has(k) && !tiles.has(k) && !d.floor.has(k);
  // a quarter's value: { f, r } (floor, roof relative to the floor), null (no tile, wall/window/door, unknown) or 'S' (stairs)
  const base = (x, y) => {
    const k = key(x, y);
    if (!exists(x, y)) return null;
    if (d.stairs.has(k)) return 'S';
    if (roomOnly(k)) return null;
    // walls, windows and doors have a floor level but no roof of their own (w)
    if (bounds.has(k)) return { f: d.floor.get(k) || 0, r: 0, w: true };
    return { f: d.floor.get(k) || 0, r: d.roof.get(k) || 0 };
  };
  const isVal = (v) => v && typeof v === 'object';
  const warnings = [];
  const warn = (kind, x, y, msg) => warnings.push({ kind, x, y, msg });

  // cut tiles: regions, hand-set values, then the rest from the side neighbours (solved together)
  const OUTER = [[[0, -1, 2], [-1, 0, 1]], [[0, -1, 3], [1, 0, 0]], [[0, 1, 0], [-1, 0, 3]], [[0, 1, 1], [1, 0, 2]]];
  const regionsOf = new Map(), cutQ = new Map(), manual = new Map();
  for (const [k, arms] of d.cuts) {
    if (d.stairs.has(k) || roomOnly(k)) continue;  // stairs cut through: still stairs; walls and space: rooms only
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
  // a stairs end: the set bottom step, else the facing side of the next tile; when that side has no single
  // level (a cut tile whose part there is still unknown), the tile after it along the stairs
  const SIDE_Q = { N: [2, 3], S: [0, 1], E: [1, 3], W: [0, 2] };
  const one = (qs) => (isVal(qs[0]) && isVal(qs[1]) && qs[0].f === qs[1].f) ? qs[0].f : null;
  const endOf = (x, y, dir, high) => {
    const [dx, dy] = DIRS[dir], sg = high ? 1 : -1, side = high ? OPP[dir] : dir;
    for (let n = 1; n <= 2; n++) {
      const nx = x + sg * dx * n, ny = y + sg * dy * n, k = key(nx, ny);
      if (d.stairs.has(k)) return null;
      const v = one(SIDE_Q[side].map(i => quarter(nx, ny, i)));
      if (v != null) return v;
      if (!cutQ.has(k)) return null;      // only look past a cut tile
    }
    return null;
  };
  const stairEnds = (k) => {
    const [x, y] = unkey(k), dir = d.stairs.get(k);
    const set = d.stairLevels.has(k) ? d.stairLevels.get(k) : null;
    return { front: endOf(x, y, dir, false), lo: set != null ? set : endOf(x, y, dir, false), hi: endOf(x, y, dir, true), set };
  };
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (const [k, regions] of regionsOf) {
      const [x, y] = unkey(k), q = cutQ.get(k), man = manual.get(k);
      for (const reg of regions) {
        const count = new Map(), wallCount = new Map();
        for (const i of reg) for (const [dx, dy, j] of OUTER[i]) {
          let v = quarter(x + dx, y + dy, j);
          if (v === 'S') {
            // stairs next to a cut part: it gets the stairs' bottom (in front) or top (behind)
            const sk = key(x + dx, y + dy), [sx, sy] = DIRS[d.stairs.get(sk)];
            const e = stairEnds(sk), f = (-dx === sx && -dy === sy) ? e.hi : (dx === sx && dy === sy) ? e.lo : null;
            v = f == null ? null : { f, r: d.roof.get(sk) || 0 };
          }
          if (isVal(v)) { const kk = v.f + '|' + v.r, m2 = v.w ? wallCount : count; m2.set(kk, (m2.get(kk) || 0) + 1); }
        }
        // floor tiles next to the part decide; walls, windows and doors only when there's no floor next to it
        let best = null, bn = 0;
        for (const [v, n] of (count.size ? count : wallCount)) if (n > bn) { best = v; bn = n; }
        const auto = best ? best.split('|').map(Number) : null;
        const m = man[reg[0]];
        const f = m.floor !== false ? m.floor : auto ? auto[0] : null;
        const r = m.roof !== false ? m.roof : auto ? auto[1] : 0;
        const val = f == null ? null : bounds.has(k) ? { f, r: 0, w: true } : { f, r };
        for (const i of reg) {
          const o = q[i];
          if ((o === null) !== (val === null) || (o && val && (o.f !== val.f || o.r !== val.r))) { q[i] = val; moved = true; }
        }
      }
    }
    if (!moved) break;
  }
  for (const k of d.cutLevels.keys()) if (!d.cuts.has(k) || d.stairs.has(k) || roomOnly(k)) { const [x, y] = unkey(k); warn('check', x + 0.5, y + 0.5, 'Hand-set cut levels on a tile that is no longer a plain cut tile (ignored; the eraser drops them)'); }

  // the tiles worth looking at: everything marked and its neighbours
  const marked = new Set([...d.floor.keys(), ...d.roof.keys(), ...d.cuts.keys(), ...d.stairs.keys()]);
  const edgeHalves = halvesOf(d.edges);
  for (const ek of edgeHalves.keys()) { const p = ek.split(','); marked.add(p[0] + ',' + p[1]); const [dx, dy] = DIRS[p[2]]; marked.add(key(+p[0] + dx, +p[1] + dy)); }
  const look = new Set();
  for (const k of marked) { const [x, y] = unkey(k); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) look.add(key(x + dx, y + dy)); }

  const stubs = [], cutLines = [], errEdges = new Set();
  const stubPair = (a, b, sa, sb, pos) => {
    if (a.f !== b.f) stubs.push({ ...pos, side: a.f < b.f ? sa : sb, kind: 'floor', h: Math.abs(a.f - b.f) });
    const ra = a.f + a.r, rb = b.f + b.r;
    if (ra !== rb && !a.w && !b.w) stubs.push({ ...pos, side: ra > rb ? sa : sb, kind: 'roof', h: Math.abs(ra - rb) });
  };
  const tooBig = (a, b, x, y) => {
    if (Math.abs(a.f - b.f) > MAX_STEP) warn('error', x, y, `Floor step of ${Math.abs(a.f - b.f)} levels (more than ${MAX_STEP})`);
    else if (!a.w && !b.w && Math.abs((a.f + a.r) - (b.f + b.r)) > MAX_STEP) warn('error', x, y, `Roof step of ${Math.abs((a.f + a.r) - (b.f + b.r))} levels (more than ${MAX_STEP})`);
  };

  // every edge cut is drawn, also next to space
  for (const hk of d.edges) {
    const p = hk.split(/[,#]/), x = +p[0], y = +p[1], pi = +p[3];
    cutLines.push([...(p[2] === 'E' ? [x + 1, y + pi * 0.5, x + 1, y + pi * 0.5 + 0.5] : [x + pi * 0.5, y + 1, x + pi * 0.5 + 0.5, y + 1]), d.subEdges.has(hk)]);
  }
  // 1. tile edges: floors may only differ across a cut; roofs step anywhere
  for (const k of look) {
    const [x, y] = unkey(k);
    for (const side of ['E', 'N']) {
      const [dx, dy] = DIRS[side], bx = x + dx, by = y + dy;
      if (!exists(x, y) || !exists(bx, by)) continue;
      const ek = edgeKey(x, y, side), halves = edgeHalves.get(ek) || [false, false], anyCut = halves[0] || halves[1];
      const pairs = side === 'E' ? [[1, 0], [3, 2]] : [[2, 0], [3, 1]];
      const mx = x + 0.5 + dx / 2, my = y + 0.5 + dy / 2;
      let floorErr = null, sameFloor = true, any = false;
      for (let pi = 0; pi < 2; pi++) {
        const [qa, qb] = pairs[pi];
        const a = quarter(x, y, qa), b = quarter(bx, by, qb);
        if (!isVal(a) || !isVal(b)) continue;
        any = true;
        const half = side === 'E' ? { x: x + 1, y: y + 0.25 + pi * 0.5, ax: 'v', len: 0.3 } : { x: x + 0.25 + pi * 0.5, y: y + 1, ax: 'h', len: 0.3 };
        const sa = side === 'E' ? 'W' : 'S', sb = side === 'E' ? 'E' : 'N';
        if (a.f !== b.f) sameFloor = false;
        if (a.f !== b.f && !halves[pi]) { floorErr = floorErr || [a.f, b.f]; continue; }
        stubPair(a, b, sa, sb, half);
        tooBig(a, b, mx, my);
      }
      if (floorErr) { errEdges.add(ek); warn('error', mx, my, `Floor ${fmt(floorErr[0])} and ${fmt(floorErr[1])} touch with no cut between them`); }
      const subOnly = [0, 1].every(pi => !halves[pi] || d.subEdges.has(ek + '#' + pi));
      if (anyCut && any && sameFloor && subOnly) warn('check', mx, my, 'Edge subcut between two tiles on the same floor level');
    }
  }

  // 2. cut tiles: arms, stubs per arm, two different floors around it
  const ARM_END = { n: [0.5, 1], s: [0.5, 0], w: [0, 0.5], e: [1, 0.5] };
  for (const [k, arms] of d.cuts) {
    const [x, y] = unkey(k);
    if (d.stairs.has(k) || roomOnly(k)) { for (const a of arms) { const [ex, ey] = ARM_END[a]; cutLines.push([x + 0.5, y + 0.5, x + ex, y + ey, d.subCuts.has(k)]); } continue; }
    const q = cutQ.get(k);
    if (arms.length === 1) warn('check', x + 0.5, y + 0.5, 'A cut line ends in the middle of this tile');
    const floors = new Set(q.filter(isVal).map(v => v.f));
    for (const a of arms) {
      const [ex, ey] = ARM_END[a];
      cutLines.push([x + 0.5, y + 0.5, x + ex, y + ey, d.subCuts.has(k)]);
      const [qa, qb] = ARM_SEP[a].map(i => q[i]);
      if (!isVal(qa) || !isVal(qb)) continue;
      const sides = { n: ['W', 'E'], e: ['N', 'S'], s: ['E', 'W'], w: ['S', 'N'] }[a];
      const pos = { x: x + (0.5 + ex) / 2, y: y + (0.5 + ey) / 2, ax: (a === 'n' || a === 's') ? 'v' : 'h', len: 0.3 };
      stubPair(qa, qb, sides[0], sides[1], pos);
      tooBig(qa, qb, x + 0.5, y + 0.5);
    }
    if (floors.size < 2 && d.subCuts.has(k)) {      // a main cut between equal floors just splits rooms
      const lvl = (xx, yy) => { const v = base(xx, yy); return isVal(v) && !d.cuts.has(key(xx, yy)) ? v.f : null; };
      const n = lvl(x, y + 1), s2 = lvl(x, y - 1), w = lvl(x - 1, y), e = lvl(x + 1, y);
      const num = (v) => typeof v === 'number';
      const wrong = arms === 'ns' ? (num(n) && num(s2) && n !== s2) : arms === 'we' ? (num(w) && num(e) && w !== e) : false;
      warn('error', x + 0.5, y + 0.5, wrong
        ? `Subcut line runs the wrong way: the floor changes ${arms === 'ns' ? 'south to north (use a west–east line)' : 'west to east (use a north–south line)'}`
        : 'Subcut without two different floor levels around it (subcuts are only for height steps)');
    }
  }

  // 3. stairs: bottom step = the set level, else the tile in front; top = the tile behind
  const stairInfo = [];
  for (const [k, dir] of d.stairs) {
    const [x, y] = unkey(k);
    const [dx, dy] = DIRS[dir];
    const { front, lo, hi, set } = stairEnds(k);
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

  return { quarter, warnings, stubs, cutLines, stairInfo, errEdges, manual, regionsOf, roomOnly };
}

// ---------------------------------------------------------------- rooms
// Rooms are made only by the user's main cuts (no automatic splitting at walls, windows or doors): every
// tile except Space, Lattice and FloorLattice, 4-connected, split only by main cuts (middle and edge).
// Subcuts don't split rooms. Worked out per quarter, so a main cut tile is split between the rooms on its
// sides. Ids from 1, in order of each room's lowest tile (y, then x). roomTiles: Set "x,y".
export function findRooms(d, mapTiles) {
  // the area looked at: every map tile (floor, lattice, walls…) and every cut, plus one tile around
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (k) => { const [x, y] = unkey(k); if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  for (const k of mapTiles) grow(k);
  for (const k of d.cuts.keys()) grow(k);
  for (const hk of d.edges) { const p = hk.split(','); grow(p[0] + ',' + p[1]); }
  const empty = { list: [], byId: new Map(), tileRoom: new Map(), partRoom: new Map(), space: new Set(), roomAt: () => null, warnings: [] };
  if (!isFinite(x0)) return empty;
  x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
  const W = x1 - x0 + 1, H = y1 - y0 + 1, N = W * H;
  const parent = new Int32Array(N * 4);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a < b ? b : a] = a < b ? a : b; };
  const mainHalf = (hk) => d.edges.has(hk) && !d.subEdges.has(hk);
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const x = tx + x0, y = ty + y0, k = key(x, y), b = (ty * W + tx) * 4;
    const A = d.cuts.has(k) && !d.subCuts.has(k) ? armsOf(d.cuts.get(k)) : null;
    for (const a of ['n', 'e', 's', 'w']) if (!A || !A.has(a)) join(b + ARM_SEP[a][0], b + ARM_SEP[a][1]);
    if (tx + 1 < W) { const be = b + 4, ek = x + ',' + y + ',E'; if (!mainHalf(ek + '#0')) join(b + 1, be + 0); if (!mainHalf(ek + '#1')) join(b + 3, be + 2); }
    if (ty + 1 < H) { const bn = b + W * 4, ek = x + ',' + y + ',N'; if (!mainHalf(ek + '#0')) join(b + 2, bn + 0); if (!mainHalf(ek + '#1')) join(b + 3, bn + 1); }
  }
  // the part that reaches the edge of the area is the station's own room; there, space is Outside.
  // A part closed off by cuts is a room of its own, space and all.
  const outer = find(0);
  const groups = new Map();
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const k = key(tx + x0, ty + y0), b = (ty * W + tx) * 4, real = mapTiles.has(k);
    for (let i = 0; i < 4; i++) {
      const r = find(b + i);
      if (r === outer && !real) continue;
      if (!groups.has(r)) groups.set(r, { root: r, tiles: new Set(), q: 0 });
      const gp = groups.get(r); gp.tiles.add(k); gp.q++;
    }
  }
  const order = [...groups.values()].map(gp => {
    let mx = Infinity, my = Infinity, sx = 0, sy = 0;
    for (const k of gp.tiles) { const [x, y] = unkey(k); if (y < my || (y === my && x < mx)) { mx = x; my = y; } sx += x; sy += y; }
    return { gp, mx, my, cx: sx / gp.tiles.size + 0.5, cy: sy / gp.tiles.size + 0.5 };
  }).sort((a, b) => a.my - b.my || a.mx - b.mx);
  const rootId = new Map(), list = [];
  order.forEach((o, i) => {
    const id = i + 1;
    rootId.set(o.gp.root, id);
    let best = null, bd = Infinity;
    for (const k of o.gp.tiles) { const [x, y] = unkey(k), dd = (x + 0.5 - o.cx) ** 2 + (y + 0.5 - o.cy) ** 2; if (dd < bd) { bd = dd; best = [x + 0.5, y + 0.5]; } }
    list.push({ id, size: o.gp.q / 4, tiles: o.gp.tiles, lx: best[0], ly: best[1], name: null, names: [] });
  });
  const tileRoom = new Map(), partRoom = new Map(), space = new Set();
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const k = key(tx + x0, ty + y0), b = (ty * W + tx) * 4, real = mapTiles.has(k);
    const ids = [0, 1, 2, 3].map(i => { const r = find(b + i); return (r === outer && !real) ? null : rootId.get(r); });
    if (ids.every(v => v == null)) continue;
    if (!real) space.add(k);
    if (ids.every(v => v === ids[0])) tileRoom.set(k, ids[0]); else partRoom.set(k, ids);
  }
  const roomAt = (k, qi) => tileRoom.has(k) ? tileRoom.get(k) : partRoom.has(k) ? partRoom.get(k)[qi] : null;
  const byId = new Map(list.map(r => [r.id, r]));
  // names, from their anchors
  const warnings = [];
  for (const [anchor, name] of d.roomNames) {
    const i = anchor.lastIndexOf('#'), k = anchor.slice(0, i), qi = +anchor.slice(i + 1) || 0, [x, y] = unkey(k);
    const id = roomAt(k, qi);
    if (id == null) { warnings.push({ kind: 'check', x: x + 0.5, y: y + 0.5, msg: `Room name “${name}” is on a tile that is no longer in a room (not saved; set it again)` }); continue; }
    byId.get(id).names.push(name);
  }
  for (const anchor of d.noHull) {
    const i = anchor.lastIndexOf('#'), id = roomAt(anchor.slice(0, i), +anchor.slice(i + 1) || 0);
    if (id != null) byId.get(id).noHull = true;
  }
  const seen = new Map();
  for (const r of list) {
    if (!r.names.length) continue;
    r.name = r.names[0];
    if (new Set(r.names).size > 1) warnings.push({ kind: 'check', x: r.lx, y: r.ly, msg: `One room has several names (${r.names.map(n => '“' + n + '”').join(', ')}); “${r.name}” is used. Main cuts may have been removed.` });
    const low = r.name.toLowerCase();
    if (seen.has(low)) warnings.push({ kind: 'check', x: r.lx, y: r.ly, msg: `Two rooms are named “${r.name}”` }); else seen.set(low, r.id);
  }
  return { list, byId, tileRoom, partRoom, space, roomAt, warnings };
}

// ---------------------------------------------------------------- the tool
export function createLevels(env) {
  // env: { pane, getScene, getRenderer, gridLocal, gridWorld, setGridXf, camScale, redraw, jumpTo, toast,
  //        download, mapSource, mapKey, getArea, setTool, isActive, safeName, lsGet, lsSet }
  const doc = new LevelsDoc();
  const ui = { mode: 'paint', layer: 'floor', level: 1, edgeLen: 'full', tier: 'main', shape: 'ns', autoJoin: false, stairDir: 'auto', brush: 1, show: true, onlyMarks: false, autoKind: 'edge', roomSel: null, levelMem: { floor: 1, roof: 0 }, roomTool: 'select', clearLv: false, visCheck: false, visLock: null };
  let analysis = new Map();
  let cache = { scene: null, map: new Map() };
  let mapSha1 = null, fileNote = '';
  let drag = null, hover = null, altDown = false, ver = 0;
  const roomCache = new Map();   // uid -> { ver, scene, rooms }

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
  // floor tiles for rooms (§1): every tile but Space, Lattice and FloorLattice
  const roomTilesOf = (uid) => sceneCache('r|' + uid, (scene) => {
    const s = new Set();
    for (const t of (scene ? (scene.tiles.get(+uid) || scene.tiles.get(uid) || []) : [])) if (t.name !== 'Lattice' && t.name !== 'FloorLattice') s.add(key(t.x, t.y));
    return s;
  });
  function roomsOf(uid) {
    uid = String(uid);
    const c = roomCache.get(uid), scene = env.getScene();
    if (c && c.ver === ver && c.scene === scene) return c.rooms;
    const rooms = findRooms(doc.grids.get(uid) || new GridLevels(), tilesOf(uid));
    roomCache.set(uid, { ver, scene, rooms });
    return rooms;
  }
  const gridUids = () => { const R = env.getRenderer(); return R.grids ? [...R.grids.keys()].map(String) : []; };
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
    ver++;
    for (const [uid, d] of doc.grids) {
      if (d.empty) continue;
      const an = analyse(d, tilesOf(uid), boundsOf(uid));
      if (d.roomNames.size) an.warnings.push(...roomsOf(uid).warnings);
      analysis.set(uid, an);
    }
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
  // the chosen level, or none when "Clear" is picked (the tile goes back to unassigned)
  const curLv = () => ui.clearLv ? null : ui.level;
  const lvText = () => ui.clearLv ? 'clear' : fmt(ui.level);
  const lvColor = () => ui.clearLv ? '#ffffff' : levelColor(ui.level);
  function paintTile(d, x, y, v) { const m = ui.layer === 'floor' ? d.floor : d.roof, k = key(x, y); if (ui.clearLv || v == null) m.delete(k); else m.set(k, v); }
  // Cut tiles follow the floors next to them. Only a stroke that starts on a cut tile (or stairs) with the
  // 1×1 brush sets a part by hand (or the bottom step); a stroke that starts on a plain tile passes over them.
  function paintAt(h, onCut) {
    const d = doc.g(h.uid), [x0, y0] = tileOf(h), k0 = key(x0, y0);
    if (onCut) {
      if (d.stairs.has(k0)) { const m = ui.layer === 'floor' ? d.stairLevels : d.roof; if (ui.clearLv) m.delete(k0); else m.set(k0, ui.level); }
      else if (d.cuts.has(k0) && (tilesOf(h.uid).has(k0) || d.floor.has(k0))) setRegion(d, k0, quarterAt(h), ui.layer, curLv());
      return;
    }
    const r = (ui.brush - 1) / 2, bounds = boundsOf(h.uid);
    if (ui.brush === 1 && d.cuts.has(k0) && bounds.has(k0) && !d.stairs.has(k0)) { setRegion(d, k0, quarterAt(h), ui.layer, curLv()); return; }
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) {
      const k = key(x, y);
      if (d.cuts.has(k) || (d.stairs.has(k) && ui.layer === 'floor')) continue;
      if (ui.layer === 'roof' && bounds.has(k)) continue;        // walls, windows and doors have no roof of their own
      paintTile(d, x, y, ui.level);
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
    if (ui.tier === 'sub') d.subCuts.add(k); else d.subCuts.delete(k);
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
    d.cuts.delete(k); d.subCuts.delete(k); d.cutLevels.delete(k); d.stairs.delete(k); d.stairLevels.delete(k);
    for (const s of ['N', 'E', 'S', 'W']) { const ek = edgeKey(x, y, s); for (const hk of [ek + '#0', ek + '#1']) { d.edges.delete(hk); d.subEdges.delete(hk); } }
    (ui.layer === 'floor' ? d.floor : d.roof).delete(k);
  }
  // the edge (stored E/N form) and half nearest the cursor
  function edgeHalfAt(h) {
    const [x, y] = tileOf(h), side = nearestSide(h).toUpperCase(), fx = h.lx - x, fy = h.ly - y;
    const ek = edgeKey(x, y, side);
    const half = (side === 'E' || side === 'W') ? (fy < 0.5 ? 0 : 1) : (fx < 0.5 ? 0 : 1);
    return { ek, half, side: ek.split(',')[2] };
  }
  function edgeAt(h) {
    const d = doc.g(h.uid), { ek, half } = edgeHalfAt(h);
    const keys = ui.edgeLen === 'half' ? [ek + '#' + half] : [ek + '#0', ek + '#1'];
    // clicking an edge cut of the same tier removes it; of the other tier, changes its tier
    const sub = ui.tier === 'sub';
    const allSame = keys.every(k => d.edges.has(k) && d.subEdges.has(k) === sub);
    for (const k of keys) {
      if (allSame) { d.edges.delete(k); d.subEdges.delete(k); }
      else { d.edges.add(k); if (sub) d.subEdges.add(k); else d.subEdges.delete(k); }
    }
  }
  // ---- dot tool: points on a half-tile lattice (X, Y = 2 × position). Both odd: a tile centre; one odd: the
  // middle of a tile edge; both even: a tile corner. Neighbouring points are joined by cut pieces: centre to
  // edge middle = an arm of that tile; edge middle to corner = half an edge cut. A dot joins itself to every
  // neighbouring point that already has a cut (or a dot), and also through a free point to the one after it
  // in a straight line. A dot with nothing to join stays as a dot until a later one joins it.
  const LK = (X, Y) => X + ',' + Y;
  const oddN = (n) => ((n % 2) + 2) % 2 === 1;
  // the cut piece between two neighbouring lattice points: { arm: [tileKey, a] } or { half: hk }
  function piece(X1, Y1, X2, Y2) {
    let cX = X1, cY = Y1, oX = X2, oY = Y2;
    if (oddN(X2) && oddN(Y2)) { cX = X2; cY = Y2; oX = X1; oY = Y1; }
    if (oddN(cX) && oddN(cY)) {
      const a = oX > cX ? 'e' : oX < cX ? 'w' : oY > cY ? 'n' : 's';
      return { arm: [key((cX - 1) / 2, (cY - 1) / 2), a] };
    }
    // edge middle to corner
    let mX = X1, mY = Y1, kX = X2, kY = Y2;
    if (!oddN(X1) && !oddN(Y1)) { mX = X2; mY = Y2; kX = X1; kY = Y1; }
    if (!oddN(mX)) return { half: (mX / 2 - 1) + ',' + ((mY - 1) / 2) + ',E#' + (kY > mY ? 1 : 0) };   // a vertical edge
    return { half: ((mX - 1) / 2) + ',' + (mY / 2 - 1) + ',N#' + (kX > mX ? 1 : 0) };                   // a horizontal edge
  }
  const hasPiece = (d, pc) => pc.arm ? (d.cuts.get(pc.arm[0]) || '').includes(pc.arm[1]) : d.edges.has(pc.half);
  function addPiece(d, pc) {
    if (pc.arm) {
      const [k, a] = pc.arm, had = d.cuts.has(k);
      d.cuts.set(k, canonArms((d.cuts.get(k) || '') + a));
      if (!had) { if (ui.tier === 'sub') d.subCuts.add(k); else d.subCuts.delete(k); }
    } else addEdgeHalf(d, pc.half);
  }
  function removePiece(d, pc) {
    if (pc.arm) {
      const [k, a] = pc.arm, rest = (d.cuts.get(k) || '').replace(a, '');
      if (rest) d.cuts.set(k, rest); else { d.cuts.delete(k); d.subCuts.delete(k); d.cutLevels.delete(k); }
    } else { d.edges.delete(pc.half); d.subEdges.delete(pc.half); }
  }
  const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // does point P have a cut (or a dot), not counting the piece towards (eX, eY)
  function pointHas(d, X, Y, eX, eY) {
    if (d.dots.has(LK(X, Y))) return true;
    for (const [dx, dy] of STEPS) { if (X + dx === eX && Y + dy === eY) continue; if (hasPiece(d, piece(X, Y, X + dx, Y + dy))) return true; }
    return false;
  }
  // the pieces a dot at (X, Y) would add
  function dotPieces(d, X, Y) {
    const out = [];
    for (const [dx, dy] of STEPS) {
      const qX = X + dx, qY = Y + dy, pq = piece(X, Y, qX, qY);
      if (hasPiece(d, pq)) continue;
      if (pointHas(d, qX, qY, X, Y)) { out.push(pq); continue; }
      const rX = qX + dx, rY = qY + dy;               // through a free point to the next one in line
      if (pointHas(d, rX, rY, qX, qY)) { out.push(pq); const qr = piece(qX, qY, rX, rY); if (!hasPiece(d, qr)) out.push(qr); }
    }
    return out;
  }
  const latticeAt = (h) => [Math.round(h.lx * 2), Math.round(h.ly * 2)];
  function dotAt(h, remove) {
    const d = doc.g(h.uid), [X, Y] = latticeAt(h), lk = LK(X, Y);
    if (remove) {
      let n = d.dots.delete(lk) ? 1 : 0;
      for (const [dx, dy] of STEPS) { const pc = piece(X, Y, X + dx, Y + dy); if (hasPiece(d, pc)) { removePiece(d, pc); n++; } }
      return n > 0;
    }
    const pcs = dotPieces(d, X, Y);
    for (const pc of pcs) addPiece(d, pc);
    // dots that now have a cut piece are done
    const touched = new Set([lk]);
    for (const pc of pcs) for (const [dx, dy] of STEPS) touched.add(LK(X + dx, Y + dy)), touched.add(LK(X + 2 * dx, Y + 2 * dy));
    for (const t of touched) if (d.dots.has(t)) { const [tX, tY] = t.split(',').map(Number); d.dots.delete(t); if (!pointHas(d, tX, tY, NaN, NaN)) d.dots.add(t); }
    if (!pcs.length) { if (pointHas(d, X, Y, NaN, NaN)) return false; d.dots.add(lk); }
    return true;
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

  // ---- automatic cuts: where different floors touch with no cut, inside the brush (or everywhere)
  const isVal = (v) => v && typeof v === 'object';
  function brushKeys(h) {
    const [x0, y0] = tileOf(h), r = (ui.brush - 1) / 2, out = [];
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) out.push(key(x, y));
    return out;
  }
  function addEdgeHalf(d, hk) { d.edges.add(hk); if (ui.tier === 'sub') d.subEdges.add(hk); else d.subEdges.delete(hk); }
  // edge cuts on every half edge of these tiles where the floors differ and nothing cuts yet
  function autoEdges(d, an, keys) {
    let n = 0;
    const done = new Set();
    for (const k of keys) {
      const [x, y] = unkey(k);
      for (const side of ['N', 'E', 'S', 'W']) {
        const ek = edgeKey(x, y, side);
        if (done.has(ek)) continue;
        done.add(ek);
        const p = ek.split(','), ex = +p[0], ey = +p[1], st = p[2], [dx, dy] = DIRS[st];
        const pairs = st === 'E' ? [[1, 0], [3, 2]] : [[2, 0], [3, 1]];
        for (let pi = 0; pi < 2; pi++) {
          const hk = ek + '#' + pi;
          if (d.edges.has(hk)) continue;
          const a = an.quarter(ex, ey, pairs[pi][0]), b = an.quarter(ex + dx, ey + dy, pairs[pi][1]);
          if (isVal(a) && isVal(b) && a.f !== b.f) { addEdgeHalf(d, hk); n++; }
        }
      }
    }
    return n;
  }
  // middle cuts: a plain floor tile next to a different floor becomes a cut tile whose line runs through
  // its middle; its parts then take the floors on their sides. Of two touching tiles, the higher one is cut.
  function autoMiddles(d, an, keys, uid) {
    const tiles = tilesOf(uid), bounds = boundsOf(uid);
    const plain = (k) => tiles.has(k) && !bounds.has(k) && !d.cuts.has(k) && !d.stairs.has(k);
    const halfCut = (x, y, dx, dy, i) => {
      const side = dx > 0 ? 'E' : dx < 0 ? 'W' : dy > 0 ? 'N' : 'S', ek = edgeKey(x, y, side);
      const half = (side === 'E' || side === 'W') ? (i < 2 ? 0 : 1) : (i & 1);
      return d.edges.has(ek + '#' + half);
    };
    // each quarter that touches a different floor (with no cut between) takes that floor, so the step moves
    // from the tile edge to the tile's middle; the arms are the lines between quarters that differ
    const cand = new Map();
    for (const k of keys) {
      if (!plain(k)) continue;
      const [x, y] = unkey(k), t = d.floor.get(k) || 0, self = t + '|' + (d.roof.get(k) || 0);
      const want = [self, self, self, self], diffs = [];
      for (let i = 0; i < 4; i++) for (const [dx, dy, j] of OUTER_Q[i]) {
        const v = an.quarter(x + dx, y + dy, j);
        if (!isVal(v) || v.f === t || halfCut(x, y, dx, dy, i)) continue;
        if (want[i] === self) want[i] = v.f + '|' + v.r;
        diffs.push({ k: key(x + dx, y + dy), f: v.f });
      }
      if (!diffs.length) continue;
      const arms = ['n', 's', 'w', 'e'].filter(a => want[ARM_SEP[a][0]] !== want[ARM_SEP[a][1]]);
      if (arms.length < 2) continue;
      cand.set(k, { t, arms: arms.join(''), diffs });
    }
    let n = 0;
    for (const [k, c] of cand) {
      if (c.diffs.some(df => cand.has(df.k) && df.f > c.t)) continue;
      d.cuts.set(k, canonArms(c.arms));
      if (ui.tier === 'sub') d.subCuts.add(k); else d.subCuts.delete(k);
      n++;
    }
    return n;
  }
  function autoRun(uid, keys) {
    const d = doc.g(uid), an = analyse(d, tilesOf(uid), boundsOf(uid));
    return ui.autoKind === 'edge' ? autoEdges(d, an, keys) : autoMiddles(d, an, keys, uid);
  }
  function autoAt(h) { autoRun(h.uid, brushKeys(h)); }
  function autoEverywhere() {
    if (!env.mapSource()) { env.toast('Open a map first', true); return; }
    doc.snapshot();
    let n = 0;
    for (const uid of gridUids()) { const t = tilesOf(uid); if (t.size) n += autoRun(uid, [...t]); }
    if (!n) { doc.undoStack.pop(); env.toast('Nothing to add: everywhere different floors touch, there is already a cut'); return; }
    changed();
    env.toast(`${n} ${ui.autoKind === 'edge' ? 'half edge cuts' : 'cut tiles'} added (Ctrl+Z undoes them all)`);
  }

  // ---- rooms: click to select one, then name it in the pane
  function selectRoom(h) {
    const [x, y] = tileOf(h), k = key(x, y), qi = quarterAt(h), R = roomsOf(h.uid), id = R.roomAt(k, qi);
    ui.roomSel = id == null ? null : { uid: h.uid, anchor: k + '#' + qi };
    if (id == null) env.toast('That tile isn’t in a room (space and lattice have none)', true);
    renderPane(); env.redraw();
    const inp = env.pane && env.pane.querySelector('#lvRoomName');
    if (inp) { inp.focus(); inp.select(); }
  }
  const selRoom = () => {
    if (!ui.roomSel) return null;
    const a = ui.roomSel.anchor, i = a.lastIndexOf('#'), R = roomsOf(ui.roomSel.uid), id = R.roomAt(a.slice(0, i), +a.slice(i + 1));
    return id == null ? null : { R, room: R.byId.get(id) };
  };
  // space tiles in rooms: tiles with no floor that the user adds, so cuts can make rooms out in space
  function spaceAt(h, remove) {
    const d = doc.g(h.uid), real = roomTilesOf(h.uid);
    for (const k of brushKeys(h)) {
      if (remove) d.spaceTiles.delete(k);
      else if (!real.has(k)) d.spaceTiles.add(k);
    }
  }
  function setNoHull(on) {
    const sr = selRoom();
    if (!sr) return;
    doc.snapshot();
    const d = doc.g(ui.roomSel.uid);
    for (const a of [...d.noHull]) { const i = a.lastIndexOf('#'); if (sr.R.roomAt(a.slice(0, i), +a.slice(i + 1)) === sr.room.id) d.noHull.delete(a); }
    if (on) d.noHull.add(ui.roomSel.anchor);
    changed();
  }
  // roofs belong to floors: anything painted on walls, windows and doors is dropped
  function resetFloors(quiet) {
    let n = 0;
    for (const d of doc.grids.values()) {
      n += d.floor.size; d.floor.clear();
      for (const [k, o] of [...d.cutLevels]) {
        for (const q of QNAMES) if (o[q]) { if (o[q].floor != null) n++; delete o[q].floor; if (o[q].roof == null) delete o[q]; }
        if (!Object.keys(o).length) d.cutLevels.delete(k);
      }
    }
    return n;
  }
  function stripWallRoofs() {
    let n = 0;
    for (const [uid, d] of doc.grids) { const b = boundsOf(uid); for (const k of [...d.roof.keys()]) if (b.has(k)) { d.roof.delete(k); n++; } }
    if (n) { changed(); env.toast(`Removed the roof from ${n} wall, window and door tile${n === 1 ? '' : 's'} (they have no roof of their own)`); }
  }
  // fill bucket for floors: spreads over the map's tiles (walls, windows and doors included) from the
  // clicked part of a tile, stopped by every cut, main and sub, middle and edge, and by space
  function fillAt(h) {
    const d = doc.g(h.uid), tiles = tilesOf(h.uid), [sx, sy] = tileOf(h), k0 = key(sx, sy);
    if (!tiles.has(k0)) { env.toast('Click a tile, not space', true); return false; }
    const qd = (k) => d.cuts.has(k) ? armsOf(d.cuts.get(k)) : null;
    const seen = new Set(), stack = [k0 + '#' + quarterAt(h)];
    const push = (k, qi) => { if (!tiles.has(k)) return; const id = k + '#' + qi; if (!seen.has(id)) stack.push(id); };
    // quarter neighbours across a tile edge: [dx, dy, my quarter -> their quarter, edge side, half]
    const ACROSS = { 0: [[-1, 0, 1, 'W', 0], [0, -1, 2, 'S', 0]], 1: [[1, 0, 0, 'E', 0], [0, -1, 3, 'S', 1]], 2: [[-1, 0, 3, 'W', 1], [0, 1, 0, 'N', 0]], 3: [[1, 0, 2, 'E', 1], [0, 1, 1, 'N', 1]] };
    let guard = 0;
    while (stack.length && guard++ < 2000000) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const i = id.lastIndexOf('#'), k = id.slice(0, i), qi = +id.slice(i + 1), [x, y] = unkey(k), A = qd(k);
      for (const a of ['n', 'e', 's', 'w']) { const [p, q] = ARM_SEP[a]; if ((p === qi || q === qi) && !(A && A.has(a))) push(k, p === qi ? q : p); }
      for (const [dx, dy, oq, side, half] of ACROSS[qi]) {
        if (d.edges.has(edgeKey(x, y, side) + '#' + half)) continue;
        push(key(x + dx, y + dy), oq);
      }
    }
    // tiles wholly reached get the floor (cut tiles and stairs keep following their neighbours)
    const count = new Map();
    for (const id of seen) { const k = id.slice(0, id.lastIndexOf('#')); count.set(k, (count.get(k) || 0) + 1); }
    let n = 0;
    const bounds = boundsOf(h.uid);
    for (const [k, c] of count) {
      if (d.stairs.has(k)) continue;
      if (d.cuts.has(k)) {
        // a cut through a wall: the parts the fill reached take the level (set by hand)
        if (!bounds.has(k)) continue;
        for (let qi = 0; qi < 4; qi++) if (seen.has(k + '#' + qi)) setRegion(d, k, qi, 'floor', curLv());
        n++; continue;
      }
      if (c < 4) continue;
      if (ui.clearLv) d.floor.delete(k); else d.floor.set(k, ui.level);
      n++;
    }
    env.toast(`Floor ${lvText()} on ${n} tiles`);
    return n > 0;
  }
  function nameRoom(name) {
    const sr = selRoom();
    if (!sr) return;
    name = String(name || '').trim();
    doc.snapshot();
    const d = doc.g(ui.roomSel.uid);
    for (const a of [...d.roomNames.keys()]) { const i = a.lastIndexOf('#'); if (sr.R.roomAt(a.slice(0, i), +a.slice(i + 1)) === sr.room.id) d.roomNames.delete(a); }
    if (name) d.roomNames.set(ui.roomSel.anchor, name);
    changed();
  }

  // ---- room visibility: which rooms each room (and each tile) can see, baked on demand
  // vis: uid -> { sig, rooms: Map id -> Set(ids, 0 = outside), tiles: Map "x,y" -> Set }
  const vis = new Map();
  const VIS_N = 9, VIS_INSET = 0.02;
  let bake = null;                               // { worker, uid, total, done }
  const sightBlockTiles = (uid) => sceneCache('o|' + uid, (scene) => {
    const s = new Set();
    if (scene) for (const it of scene.items) {
      if (it.kind !== 'ent' || String(it.grid) !== String(uid) || !it.info || !it.info.oc || it.info.door != null) continue;
      s.add(key(it.tx != null ? it.tx : Math.floor(it.x), it.ty != null ? it.ty : Math.floor(it.y)));
    }
    return s;
  });
  // a fingerprint of the rooms and what blocks sight; a bake is stale when it changes
  const sigCache = new Map();
  function visSig(uid) {
    const c = sigCache.get(uid), scene = env.getScene();
    if (c && c.ver === ver && c.scene === scene) return c.sig;
    const sig = visSig1(uid);
    sigCache.set(uid, { ver, scene, sig });
    return sig;
  }
  function visSig1(uid) {
    const R = roomsOf(uid), parts = [];
    for (const [k, id] of R.tileRoom) parts.push(k + '=' + id);
    for (const [k, ids] of R.partRoom) parts.push(k + '=' + ids.join('/'));
    parts.sort();
    let h = 2166136261;
    const str = parts.join(';') + '|' + [...sightBlockTiles(uid)].sort().join(';');
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + str.length;
  }
  function visGrid(uid) {
    const R = roomsOf(uid), blocks = sightBlockTiles(uid), dd = doc.grids.get(uid);
    const all = new Set([...tilesOf(uid), ...R.space]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of all) { const [x, y] = unkey(k); if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
    const w = (x1 - x0 + 1) * 2, h = (y1 - y0 + 1) * 2, block = new Uint8Array(w * h), owner = new Int32Array(w * h);
    const put = (x, y, qi, b, o) => { const c = ((y - y0) * 2 + (qi >> 1)) * w + (x - x0) * 2 + (qi & 1); block[c] = b; owner[c] = o; };
    for (const k of all) {
      const [x, y] = unkey(k), b = blocks.has(k) ? 1 : 0;
      for (let qi = 0; qi < 4; qi++) put(x, y, qi, b, R.roomAt(k, qi) || 0);
    }
    for (const k of blocks) if (!all.has(k)) { const [x, y] = unkey(k); if (x >= x0 && x <= x1 && y >= y0 && y <= y1) for (let qi = 0; qi < 4; qi++) put(x, y, qi, 1, 0); }
    return { grid: { w, h, block, owner }, x0, y0 };
  }
  // eye points of one room: 9×9 per tile that doesn't block sight (only in its own quarters on a split tile)
  function roomJob(uid, R, room, x0, y0) {
    const blocks = sightBlockTiles(uid), tiles = [];
    for (const k of room.tiles) {
      if (blocks.has(k)) continue;
      const [x, y] = unkey(k), pts = tileEyes(x - x0, y - y0, VIS_N, VIS_INSET, []);
      let eyes = pts;
      if (R.partRoom.has(k)) {
        const ids = R.partRoom.get(k);
        eyes = [];
        for (let i = 0; i < pts.length; i += 2) {
          const qi = ((pts[i + 1] / 2 - (y - y0)) >= 0.5 ? 2 : 0) + ((pts[i] / 2 - (x - x0)) >= 0.5 ? 1 : 0);
          if (ids[qi] === room.id) eyes.push(pts[i], pts[i + 1]);
        }
      }
      if (eyes.length) tiles.push([x, y, Float64Array.from(eyes)]);
    }
    return { room: room.id, tiles };
  }
  // what one tile sees, worked out live from its 9×9 eye points (for checking): cells seen and rooms seen
  let gridCache = null, liveCache = null;
  function visGridCached(uid) {
    const scene = env.getScene();
    if (!gridCache || gridCache.uid !== uid || gridCache.ver !== ver || gridCache.scene !== scene) gridCache = { uid, ver, scene, ...visGrid(uid) };
    return gridCache;
  }
  function liveView(uid, x, y) {
    const ck = uid + '|' + x + '|' + y + '|' + ver;
    if (liveCache && liveCache.k === ck) return liveCache;
    const G = visGridCached(uid), R = roomsOf(uid), k = key(x, y);
    const cells = new Uint8Array(G.grid.w * G.grid.h), seen = new Set();
    if (!sightBlockTiles(uid).has(k)) seenFrom(G.grid, Float64Array.from(tileEyes(x - G.x0, y - G.y0, VIS_N, VIS_INSET, [])), seen, null, cells);
    const own = new Set([0, 1, 2, 3].map(qi => R.roomAt(k, qi)).filter(v => v != null));
    for (const o of own) seen.add(o);
    // the seen cells as one path, in tile units
    const path = new Path2D(), { w, h } = G.grid;
    for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) if (cells[cy * w + cx]) path.rect(G.x0 + cx / 2, G.y0 + cy / 2, 0.5, 0.5);
    liveCache = { k: ck, uid, x, y, seen, own, path, blocked: sightBlockTiles(uid).has(k) };
    return liveCache;
  }
  // the view from one exact point (the cursor), with the viewer's field-of-view code: a polygon
  let eyeCache = null;
  function pointView(uid, px, py) {
    const scene = env.getScene();
    if (!eyeCache || eyeCache.uid !== uid || eyeCache.ver !== ver || eyeCache.scene !== scene) {
      const opaque = new Set();
      for (const k of sightBlockTiles(uid)) { const [x, y] = unkey(k); opaque.add(tileKey(x, y)); }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k of tilesOf(uid)) { const [x, y] = unkey(k); if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      eyeCache = { uid, ver, scene, opaque, targets: blockerCorners(opaque), maxT: Math.hypot(x1 - x0, y1 - y0) + 4 };
    }
    if (eyeCache.opaque.has(tileKey(Math.floor(px), Math.floor(py)))) return null;
    const poly = eyePolygon(eyeCache.opaque, eyeCache.targets, px, py, eyeCache.maxT);
    const path = new Path2D();
    if (poly.length >= 6) { path.moveTo(poly[0], poly[1]); for (let i = 2; i < poly.length; i += 2) path.lineTo(poly[i], poly[i + 1]); path.closePath(); }
    return path;
  }
  function tileList(uid, x, y) {
    const st = visState(uid), k = key(x, y);
    if (st.v && !st.stale && st.v.tiles.has(k)) return { set: st.v.tiles.get(k), baked: true };
    return { set: liveView(uid, x, y).seen, baked: false };
  }
  function renderVisList() {
    const el = env.pane && env.pane.querySelector('#lvVisList');
    if (!el) return;
    const vt = ui.visLock || hover;
    if (!vt) { el.innerHTML = '<p class="hint">Point at a tile.</p>'; return; }
    const R = roomsOf(vt.uid), list = tileList(vt.uid, vt.x, vt.y), lv = liveView(vt.uid, vt.x, vt.y);
    const ids = [...list.set].sort((a, b) => (a === 0) - (b === 0) || a - b);
    const nm = (id) => id === 0 ? 'Outside' : `#${id}${R.byId.get(id) && R.byId.get(id).name ? ' ' + esc(R.byId.get(id).name) : ''}`;
    const differs = list.baked && (ids.length !== lv.seen.size || ids.some(i => !lv.seen.has(i)));
    el.innerHTML = `<p class="hint"><b>Tile ${vt.x}, ${vt.y}</b>${ui.visLock ? ' (held; click it again to let go)' : ''}: ${list.baked ? 'baked list' : 'not baked, worked out live'}${lv.blocked ? ' · this tile blocks sight, it has no eye points' : ''}</p>
      <div class="lvvislist">${ids.map(id => `<span class="lvvis"><i style="background:${id === 0 ? '#555' : roomColor(id)}"></i>${nm(id)}</span>`).join('') || '<span class="hint">nothing</span>'}</div>
      ${differs ? '<p class="lvnote">The live view differs from the baked list; bake again.</p>' : ''}`;
  }
  function visState(uid) {
    const v = vis.get(uid);
    if (!v || !v.rooms.size) return { v: null, stale: false };
    return { v, stale: v.sig !== visSig(uid) };
  }
  function bakeRooms(uid, ids) {
    if (bake) { env.toast('Already baking; wait or cancel it', true); return; }
    if (!env.getScene()) return;
    const R = roomsOf(uid), sig = visSig(uid);
    let v = vis.get(uid);
    if (!v || v.sig !== sig) { v = { sig, rooms: new Map(), tiles: new Map() }; vis.set(uid, v); }
    const { grid, x0, y0 } = visGrid(uid);
    const jobs = ids.map(id => roomJob(uid, R, R.byId.get(id), x0, y0)).filter(j => j.tiles.length);
    if (!jobs.length) { env.toast('Nothing to bake: those rooms have no tiles to stand on', true); return; }
    // every tile of every room is one piece of work, shared out over several workers
    const units = [];
    for (const j of jobs) for (const [x, y, eyes] of j.tiles) units.push([j.room, x, y, eyes]);
    const K = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1, units.length));
    const workers = [];
    try { for (let i = 0; i < K; i++) workers.push(new Worker(new URL('./roomvis-worker.js?v=4', import.meta.url), { type: 'module' })); }
    catch (e) { workers.forEach(w => w.terminate()); env.toast('Could not start the visibility workers: ' + e.message, true); return; }
    const t0 = performance.now();
    bake = { workers, uid, fresh: null, rooms: jobs.length, total: units.length, done: 0, eyes: units.reduce((n, u) => n + u[3].length / 2, 0) };
    // start the baked rooms afresh (a tile split between rooms keeps the other room's view)
    const fresh = new Set(jobs.map(j => j.room));
    bake.fresh = fresh;
    for (const id of fresh) v.rooms.set(id, new Set());
    for (const j of jobs) for (const [x, y] of j.tiles) { const k = key(x, y); if (!R.partRoom.has(k)) v.tiles.delete(k); }
    let finished = 0, lastPaint = 0;
    const finish = () => {
      workers.forEach(w => w.terminate());
      const ms = performance.now() - t0, n = bake.rooms;
      bake = null;
      saveVis();
      renderPane(); env.redraw();
      env.toast(`Visibility baked for ${n} room${n === 1 ? '' : 's'} (${(ms / 1000).toFixed(1)} s)`);
    };
    workers.forEach((w, wi) => {
      w.onmessage = (ev) => {
        const m = ev.data;
        if (!bake) return;
        if (m.type === 'tiles') {
          for (const [room, x, y, ids] of m.items) {
            const rs = v.rooms.get(room);
            for (const id of ids) if (id !== room) rs.add(id);
            const k = key(x, y);
            if (!v.tiles.has(k)) v.tiles.set(k, new Set());
            const ts = v.tiles.get(k);
            for (const id of ids) ts.add(id);
          }
          bake.done += m.items.length;
          if (performance.now() - lastPaint > 400) { lastPaint = performance.now(); renderPane(); }
        } else if (m.type === 'done' && ++finished === workers.length) finish();
      };
      w.onerror = (e) => { if (!bake) return; env.toast('Visibility failed: ' + (e.message || 'worker error'), true); workers.forEach(x => x.terminate()); bake = null; renderPane(); };
      w.postMessage({ grid, tiles: units.filter((u, i) => i % K === wi) });
    });
    renderPane();
  }
  function cancelBake() {
    if (!bake) return;
    bake.workers.forEach(w => w.terminate());
    const v = vis.get(bake.uid);
    if (v) for (const id of bake.fresh) v.rooms.delete(id);     // half-baked rooms don't count
    bake = null; saveVis(); renderPane(); env.redraw(); env.toast('Baking cancelled');
  }
  function saveVis() {
    try {
      if (!env.mapSource()) return;
      const o = {};
      for (const [uid, v] of vis) o[uid] = { sig: v.sig, rooms: [...v.rooms].map(([id, s]) => [id, [...s]]), tiles: [...v.tiles].map(([k, s]) => [k, [...s]]) };
      env.lsSet('levelsvis.' + env.mapKey(), o);
    } catch (e) { /* too big for local storage: kept in memory, saved with the file */ }
  }
  function loadVisLocal() {
    vis.clear();
    const o = env.lsGet('levelsvis.' + env.mapKey());
    if (o) for (const uid of Object.keys(o)) vis.set(uid, { sig: o[uid].sig, rooms: new Map(o[uid].rooms.map(([id, a]) => [id, new Set(a)])), tiles: new Map(o[uid].tiles.map(([k, a]) => [k, new Set(a)])) });
  }
  // the lists as written: both directions, sorted, "outside" for 0 and last
  const visName = (id) => id === 0 ? 'outside' : String(id);
  const visSort = (a, b) => (a === 0) - (b === 0) || a - b;
  function visFor(uid) {
    const { v, stale } = visState(uid);
    if (!v || stale) return null;
    const lists = new Map();
    const add = (a, b) => { if (a === b) return; if (!lists.has(a)) lists.set(a, new Set()); lists.get(a).add(b); };
    for (const [id, s] of v.rooms) for (const o of s) { add(id, o); add(o, id); }
    const visibility = {};
    for (const id of [...lists.keys()].sort(visSort)) visibility[visName(id)] = [...lists.get(id)].sort(visSort).map(visName);
    const sets = [], index = new Map(), tiles = {};
    const sorted = [...v.tiles].sort((a, b) => { const [ax, ay] = unkey(a[0]), [bx, by] = unkey(b[0]); return ay - by || ax - bx; });
    for (const [k, s] of sorted) {
      const list = [...s].sort(visSort).map(visName), sk = list.join(',');
      if (!index.has(sk)) { index.set(sk, sets.length); sets.push(list); }
      tiles[k] = index.get(sk);
    }
    return { visibility, tile_visibility: { sets, tiles } };
  }

  // ---- pointer (called by app.js while the Levels tool is active)
  function down(wx, wy, e) {
    const h = gridAt(wx, wy);
    if (!h) return;
    if (ui.mode === 'rooms' && ui.visCheck) {
      const [x, y] = tileOf(h);
      ui.visLock = ui.visLock && ui.visLock.uid === h.uid && ui.visLock.x === x && ui.visLock.y === y ? null : { uid: h.uid, x, y };
      renderPane(); env.redraw(); return;
    }
    if (ui.mode === 'rooms' && e.shiftKey) {
      const [x, y] = tileOf(h), id = roomsOf(h.uid).roomAt(key(x, y), quarterAt(h));
      if (id != null) { toggleExportRoom(h.uid, id); renderPane(); env.redraw(); }
      return;
    }
    if (ui.mode === 'rooms' && ui.roomTool === 'select') { selectRoom(h); return; }
    doc.snapshot();
    if (ui.mode === 'rooms') { drag = { kind: 'space', uid: h.uid, remove: !!e.altKey }; spaceAt(h, drag.remove); changed(); return; }
    const d = doc.g(h.uid), [x, y] = tileOf(h);
    if (ui.mode === 'paint') {
      if (e.shiftKey) { drag = { kind: 'rect', uid: h.uid, gr: h.gr, a: [h.lx, h.ly], b: [h.lx, h.ly] }; env.redraw(); return; }
      const k0 = key(x, y), onCut = ui.brush === 1 && (d.cuts.has(k0) || d.stairs.has(k0));
      drag = { kind: 'paint', uid: h.uid, onCut }; paintAt(h, onCut);
    } else if (ui.mode === 'cut') {
      if (e.altKey) { toggleArm(h); drag = null; }
      else { placeCut(d, x, y); drag = { kind: 'cut', uid: h.uid, last: key(x, y) }; }
    } else if (ui.mode === 'clear') { clearPart(h); drag = null; }
    else if (ui.mode === 'edge') { edgeAt(h); drag = null; }
    else if (ui.mode === 'fill') { drag = null; if (!fillAt(h)) { doc.undoStack.pop(); return; } }
    else if (ui.mode === 'connect') { const [X, Y] = latticeAt(h); dotAt(h, e.altKey); drag = { kind: 'dot', uid: h.uid, last: [X, Y], remove: e.altKey }; }
    else if (ui.mode === 'stairs') { stairsAt(h, e.altKey); drag = null; }
    else if (ui.mode === 'erase') { drag = { kind: 'erase', uid: h.uid }; eraseAt(h); }
    else if (ui.mode === 'auto') { drag = { kind: 'auto', uid: h.uid }; autoAt(h); }
    changed();
  }
  function move(wx, wy) {
    const h = gridAt(wx, wy);
    const prev = hover;
    hover = h ? { uid: h.uid, gr: h.gr, x: Math.floor(h.lx), y: Math.floor(h.ly), lx: h.lx, ly: h.ly } : null;
    if (ui.mode === 'rooms' && ui.visCheck && !ui.visLock && hover && (!prev || prev.x !== hover.x || prev.y !== hover.y)) renderVisList();
    showHover();
    if (!drag) { env.redraw(); return; }
    if (!h || h.uid !== drag.uid) return;
    if (drag.kind === 'rect') { drag.b = [h.lx, h.ly]; env.redraw(); return; }
    if (drag.kind === 'paint') paintAt(h, drag.onCut);
    else if (drag.kind === 'auto') autoAt(h);
    else if (drag.kind === 'space') spaceAt(h, drag.remove);
    else if (drag.kind === 'dot') {
      // a dot on every lattice point the drag passes, one step at a time, so they join into a line
      const [tX, tY] = latticeAt(h);
      let [X, Y] = drag.last, guard = 0;
      if (X === tX && Y === tY) return;
      while ((X !== tX || Y !== tY) && guard++ < 400) {
        if (Math.abs(tX - X) >= Math.abs(tY - Y)) X += Math.sign(tX - X); else Y += Math.sign(tY - Y);
        dotAt({ uid: h.uid, lx: X / 2, ly: Y / 2 }, drag.remove);
      }
      drag.last = [tX, tY];
    }
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
          if (d.cuts.has(k) || (d.stairs.has(k) && ui.layer === 'floor')) continue;
          if (tiles.has(k) && !(ui.layer === 'roof' && bounds.has(k))) paintTile(d, x, y, ui.level);
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
    for (const k of a.tiles) { if (d.cuts.has(k) || (d.stairs.has(k) && ui.layer === 'floor') || (ui.layer === 'roof' && bounds.has(k))) continue; const [x, y] = unkey(k); paintTile(d, x, y, ui.level); n++; }
    changed();
    env.toast(`${ui.layer === 'floor' ? 'Floor' : 'Roof'} ${lvText()} set on ${n} floor tiles`);
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
      t += `: stairs rising ${d.stairs.get(k)}` + (info ? `, bottom ${info.lo != null ? fmt(info.lo) : '?'}${info.set ? ' (set)' : ''}, top ${info.hi != null ? fmt(info.hi) : '?'}${info.kind ? ` (${info.kind.name})` : ''}${info.cut ? `, cut through (${info.cut})` : ''}` : '') + `, roof ${fmt(d.roof.get(k) || 0)}${d.roof.has(k) ? '' : ' (unassigned)'} above the bottom step`;
    } else if (d && d.cuts.has(k) && an && an.roomOnly(k)) {
      t += `: ${d.subCuts.has(k) ? 'subcut' : 'main cut'} ${d.cuts.get(k)} ${bk ? 'through a ' + bk : 'over space'} (splits rooms only, no level)`;
    } else if (d && d.cuts.has(k) && an) {
      const qi = (hover.ly - hover.y >= 0.5 ? 2 : 0) + (hover.lx - hover.x >= 0.5 ? 1 : 0);
      const v = an.quarter(hover.x, hover.y, qi), m = an.manual.get(k)[qi];
      t += `: ${d.subCuts.has(k) ? 'subcut' : 'main cut'} ${d.cuts.get(k)}, part ${QNAMES[qi]}` + (v ? `: floor ${fmt(v.f)}${m.floor !== false ? ' (set)' : ''}, roof ${fmt(v.r)}${m.roof !== false ? ' (set)' : ''}, absolute roof ${fmt(v.f + v.r)}` : ': no level');
    } else if (bk) t += `: ${bk}, floor ${fmt((d && d.floor.get(k)) || 0)}${d && d.floor.has(k) ? '' : ' (unassigned)'} (no roof of its own)`;
    else if (!tilesOf(hover.uid).has(k) && !(d && d.floor.has(k))) t += ': no floor';
    else {
      const f = (d && d.floor.get(k)) || 0, r = (d && d.roof.get(k)) || 0;
      const fa = d && d.floor.has(k), ra = d && d.roof.has(k);
      t += `: floor ${fmt(f)}${fa ? '' : ' (unassigned)'}, roof ${fmt(r)}${ra ? '' : ' (unassigned)'}, absolute roof ${fmt(f + r)}`;
    }
    if (ui.mode === 'rooms' || (d && d.roomNames.size)) {
      const R = roomsOf(hover.uid), qi = (hover.ly - hover.y >= 0.5 ? 2 : 0) + (hover.lx - hover.x >= 0.5 ? 1 : 0), id = R.roomAt(k, qi);
      if (id != null) { const r = R.byId.get(id); t += ` · room #${id}${r.name ? ' “' + r.name + '”' : ''} (${r.size} tiles)`; }
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
  const roomColor = (id) => `hsl(${(id * 137.508) % 360}, 75%, 58%)`;
  function drawRooms(g, s) {
    const R = env.getRenderer();
    for (const uid of gridUids()) {
      const gr = R.grids.get(+uid) || R.grids.get(uid);
      if (!gr) continue;
      const rooms = roomsOf(uid);
      if (!rooms.list.length) continue;
      g.save(); env.setGridXf(g, gr);
      const paths = new Map();
      const add = (id, x, y, w, h) => { const c = roomColor(id); if (!paths.has(c)) paths.set(c, new Path2D()); paths.get(c).rect(x, y, w, h); };
      for (const [k, id] of rooms.tileRoom) { const [x, y] = unkey(k); add(id, x, y, 1, 1); }
      for (const [k, ids] of rooms.partRoom) { const [x, y] = unkey(k); ids.forEach((id, i) => { if (id != null) add(id, x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5); }); }
      g.globalAlpha = 0.33;
      for (const [c, p] of paths) { g.fillStyle = c; g.fill(p); }
      g.globalAlpha = 1;
      // checking: everything the tile under the cursor (or the clicked one) doesn't list is hidden, the area
      // its eye points see is lit
      const vt = ui.visCheck ? (ui.visLock || (hover && hover.uid === uid ? hover : null)) : null;
      if (vt && vt.uid === uid) {
        const list = tileList(uid, vt.x, vt.y);
        const hide = new Path2D();
        for (const [k, id] of rooms.tileRoom) if (!list.set.has(id)) { const [x, y] = unkey(k); hide.rect(x, y, 1, 1); }
        for (const [k, ids] of rooms.partRoom) { const [x, y] = unkey(k); ids.forEach((id, i) => { if (id != null && !list.set.has(id)) hide.rect(x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5); }); }
        g.fillStyle = 'rgba(0,0,0,.92)'; g.fill(hide);
        // the lit view: from the cursor point itself (smooth); from the held tile's centre when one is held
        const eye = ui.visLock ? [vt.x + 0.5, vt.y + 0.5] : [hover.lx, hover.ly];
        const vp = pointView(uid, eye[0], eye[1]);
        if (vp) { g.fillStyle = 'rgba(255,214,90,.3)'; g.fill(vp); }
        g.beginPath(); g.arc(eye[0], eye[1], Math.max(3, s * 0.08) / s, 0, Math.PI * 2); g.fillStyle = '#ffd65a'; g.fill();
        g.strokeStyle = '#ffd65a'; g.lineWidth = 3 / s; g.strokeRect(vt.x, vt.y, 1, 1);
        g.restore();
        continue;
      }
      // visibility of the selected room: what it can't see is dimmed
      const srv = selRoom();
      const stv = srv && ui.roomSel.uid === uid ? visState(uid) : null;
      const seen = stv && stv.v && !stv.stale ? stv.v.rooms.get(srv.room.id) : null;
      if (seen) {
        const dim = new Path2D(), lit = new Path2D();
        const pick = (id) => (id === srv.room.id || seen.has(id)) ? lit : dim;
        for (const [k, id] of rooms.tileRoom) { const [x, y] = unkey(k); pick(id).rect(x, y, 1, 1); }
        for (const [k, ids] of rooms.partRoom) { const [x, y] = unkey(k); ids.forEach((id, i) => pick(id).rect(x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5)); }
        g.fillStyle = 'rgba(0,0,0,.72)'; g.fill(dim);
      }
      // the selected room: outlined tile by tile
      const sr = selRoom();
      if (sr && ui.roomSel.uid === uid) {
        const id = sr.room.id, p = new Path2D();
        for (const k of sr.room.tiles) {
          const [x, y] = unkey(k);
          if (rooms.tileRoom.get(k) === id) p.rect(x, y, 1, 1);
          else rooms.partRoom.get(k).forEach((v, i) => { if (v === id) p.rect(x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5); });
        }
        g.globalAlpha = 0.35; g.fillStyle = '#ffffff'; g.fill(p); g.globalAlpha = 1;
      }
      const xs = exportSel.get(uid);
      if (xs && xs.size) {
        const p = new Path2D();
        for (const [k, id] of rooms.tileRoom) if (xs.has(id)) { const [x, y] = unkey(k); p.rect(x, y, 1, 1); }
        for (const [k, ids] of rooms.partRoom) { const [x, y] = unkey(k); ids.forEach((id, i) => { if (xs.has(id)) p.rect(x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5); }); }
        g.fillStyle = 'rgba(120,200,255,.35)'; g.fill(p);
      }
      for (const r of rooms.list) {
        if (r.name) text(g, s, r.name + (r.noHull ? ' (no hull)' : ''), r.lx, r.ly, '#ffffff', 0.34);
        else if (r.noHull) text(g, s, '#' + r.id + ' (no hull)', r.lx, r.ly, 'rgba(255,255,255,.8)', 0.26);
        else if (s >= 14 && r.size >= 2) text(g, s, '#' + r.id, r.lx, r.ly, 'rgba(255,255,255,.7)', 0.22);
      }
      g.restore();
    }
  }
  function draw(g) {
    const R = env.getRenderer();
    if (!R.grids) return;
    const s = env.camScale();
    const roomsView = ui.mode === 'rooms' && env.isActive() && ui.show;
    if (roomsView) drawRooms(g, s);
    for (const [uid, d] of doc.grids) {
      const gr = R.grids.get(+uid) || R.grids.get(uid);
      if (!gr || !ui.show) continue;
      const an = analysis.get(uid);
      g.save();
      env.setGridXf(g, gr);
      if (!ui.onlyMarks && !roomsView) {
        // the chosen layer's colours; cut parts solid when set by hand, faint and hatched when worked out
        const solid = new Map(), faint = new Map();
        const add = (m, c, x, y, w, h) => { if (!m.has(c)) m.set(c, new Path2D()); m.get(c).rect(x, y, w, h); };
        const roofLayer = ui.layer === 'roof', wallsHere = boundsOf(uid);
        for (const [k, v] of (ui.layer === 'floor' ? d.floor : d.roof)) {
          if (d.cuts.has(k) || (d.stairs.has(k) && ui.layer === 'floor')) continue;
          if (roofLayer && wallsHere.has(k)) continue;           // walls have no roof: nothing drawn there
          const [x, y] = unkey(k); add(solid, levelColor(v), x, y, 1, 1);
        }
        const hatchLines = new Path2D();
        if (an) for (const k of d.cuts.keys()) {
          if (roofLayer && wallsHere.has(k)) continue;
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
        if (ui.layer === 'roof' && !ui.onlyMarks) { g.strokeStyle = levelColor(d.roof.get(k) || 0); g.lineWidth = 3 / s; g.setLineDash(d.roof.has(k) ? [] : [4 / s, 3 / s]); g.strokeRect(x + 0.12, y + 0.12, 0.76, 0.76); g.setLineDash([]); }
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
        // main cuts solid (they split rooms), subcuts dashed (height steps inside a room)
        for (const sub of [false, true]) {
          g.setLineDash(sub ? [Math.max(4, s * 0.12) / s, Math.max(3, s * 0.08) / s] : []);
          g.beginPath();
          for (const [x0, y0, x1, y1, isSub] of an.cutLines) if (!!isSub === sub) { g.moveTo(x0, y0); g.lineTo(x1, y1); }
          g.stroke();
        }
        g.setLineDash([]);
        // dots waiting to be joined
        for (const lk of d.dots) { const [X, Y] = lk.split(',').map(Number); g.beginPath(); g.arc(X / 2, Y / 2, Math.max(4, s * 0.09) / s, 0, Math.PI * 2); g.fillStyle = '#ff2bd6'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1 / s; g.stroke(); }
        g.strokeStyle = '#ff2bd6'; g.lineWidth = Math.max(2.5, s * 0.07) / s;
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
      g.fillStyle = lvColor(); g.globalAlpha = 0.25; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.globalAlpha = 1;
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 / s; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
    } else if (hover && env.isActive()) {
      g.save(); env.setGridXf(g, hover.gr);
      g.lineWidth = 2 / s;
      const x = hover.x, y = hover.y, d = doc.grids.get(hover.uid), k = key(x, y);
      const END = { n: [0.5, 1], s: [0.5, 0], w: [0, 0.5], e: [1, 0.5] };
      if (ui.mode === 'connect') {
        const dd = d || doc.g(hover.uid), [X, Y] = latticeAt(hover), pcs = altDown ? [] : dotPieces(dd, X, Y);
        g.strokeStyle = 'rgba(255,43,214,.8)'; g.lineWidth = Math.max(2.5, s * 0.07) / s;
        if (ui.tier === 'sub') g.setLineDash([Math.max(4, s * 0.12) / s, Math.max(3, s * 0.08) / s]);
        g.beginPath();
        for (const pc of pcs) {
          if (pc.arm) { const [tx, ty] = unkey(pc.arm[0]), e = END[pc.arm[1]]; g.moveTo(tx + 0.5, ty + 0.5); g.lineTo(tx + e[0], ty + e[1]); }
          else { const p = pc.half.split(/[,#]/), ex = +p[0], ey = +p[1], hf = +p[3] * 0.5; if (p[2] === 'E') { g.moveTo(ex + 1, ey + hf); g.lineTo(ex + 1, ey + hf + 0.5); } else { g.moveTo(ex + hf, ey + 1); g.lineTo(ex + hf + 0.5, ey + 1); } }
        }
        g.stroke(); g.setLineDash([]);
        g.beginPath(); g.arc(X / 2, Y / 2, Math.max(4, s * 0.09) / s, 0, Math.PI * 2);
        g.fillStyle = altDown ? '#ffffff' : '#ff2bd6'; g.fill();
      } else if (ui.mode === 'fill') {
        g.strokeStyle = lvColor(); g.lineWidth = 3 / s; g.strokeRect(x + 0.1, y + 0.1, 0.8, 0.8);
      } else if (ui.mode === 'rooms') {
        if (ui.roomTool === 'space') { const r = (ui.brush - 1) / 2; g.strokeStyle = '#9ad0ff'; g.setLineDash([4 / s, 3 / s]); g.strokeRect(x - r, y - r, 1 + 2 * r, 1 + 2 * r); g.setLineDash([]); }
      } else if (ui.mode === 'edge') {
        const { ek, half, side } = edgeHalfAt(hover), p = ek.split(','), ex = +p[0], ey = +p[1];
        const a = ui.edgeLen === 'half' ? half * 0.5 : 0, b = ui.edgeLen === 'half' ? a + 0.5 : 1;
        g.strokeStyle = '#ff2bd6'; g.lineWidth = 3 / s; if (ui.tier === 'sub') g.setLineDash([5 / s, 4 / s]); g.beginPath();
        if (side === 'E') { g.moveTo(ex + 1, ey + a); g.lineTo(ex + 1, ey + b); } else { g.moveTo(ex + a, ey + 1); g.lineTo(ex + b, ey + 1); }
        g.stroke();
      } else if (ui.mode === 'cut' && altDown) {
        const e = END[nearestSide(hover)];
        g.strokeStyle = '#ff2bd6'; g.setLineDash([3 / s, 3 / s]); g.beginPath();
        g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + e[0], y + e[1]); g.stroke(); g.setLineDash([]);
      } else if (ui.mode === 'cut') {
        g.strokeStyle = 'rgba(255,43,214,.6)'; g.lineWidth = Math.max(2.5, s * 0.07) / s; if (ui.tier === 'sub') g.setLineDash([Math.max(4, s * 0.12) / s, Math.max(3, s * 0.08) / s]); g.beginPath();
        for (const a of ui.shape) { g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + END[a][0], y + END[a][1]); }
        g.stroke();
        g.strokeStyle = '#ff2bd6'; g.lineWidth = 1.5 / s; g.strokeRect(x, y, 1, 1);
      } else if (((ui.mode === 'paint' && ui.brush === 1) || ui.mode === 'clear') && d && d.cuts.has(k) && !d.stairs.has(k)) {
        const qi = (hover.ly - y >= 0.5 ? 2 : 0) + (hover.lx - x >= 0.5 ? 1 : 0);
        g.strokeStyle = ui.mode === 'clear' ? '#ffffff' : lvColor();
        for (const i of regionOf(d, k, qi)) g.strokeRect(x + (i & 1) * 0.5, y + (i >> 1) * 0.5, 0.5, 0.5);
      } else {
        const r = (ui.mode === 'paint' || ui.mode === 'auto') ? (ui.brush - 1) / 2 : 0;
        g.strokeStyle = ui.mode === 'paint' ? lvColor() : ui.mode === 'erase' ? '#ffffff' : '#ff2bd6';
        if (ui.mode === 'auto') g.setLineDash([4 / s, 3 / s]);
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
  async function buildFile(extraUids = []) {
    const src = env.mapSource();
    reanalyse();
    const sha = mapSha1 || (mapSha1 = await sha1(src.text));
    const keep = new Set([...vis.keys()].filter(u => visState(u).v));
    for (const u of extraUids) keep.add(String(u));
    for (const u of keep) doc.g(u);
    const file = doc.toFile(String(src.name || 'map.yml').split('/').pop(), sha, (uid) => roomsOf(uid), keep);
    let staleVis = 0;
    for (const uid of Object.keys(file.grids)) {
      const st = visState(uid);
      if (st.v && st.stale) staleVis++;
      const fv = visFor(uid);
      if (fv) Object.assign(file.grids[uid], fv);
    }
    // the worked-out levels (output only; the viewer works them out again when loading)
    for (const uid of Object.keys(file.grids)) {
      const d = doc.grids.get(uid), an = analysis.get(uid);
      if (!d || !an) continue;
      const quarters = {}, stairs = {};
      const sortK = (a, b) => { const [ax, ay] = unkey(a), [bx, by] = unkey(b); return ay - by || ax - bx; };
      for (const k of [...d.cuts.keys()].sort(sortK)) {
        if (d.stairs.has(k) || an.roomOnly(k) || d.cuts.get(k).length < 2) continue;
        const [x, y] = unkey(k), o = {};
        let ok = true;
        QNAMES.forEach((q, i) => { const v = an.quarter(x, y, i); if (v && typeof v === 'object') o[q] = [v.f, v.r]; else ok = false; });
        if (ok) quarters[k] = o;
      }
      for (const info of [...an.stairInfo].sort((a, b) => a.y - b.y || a.x - b.x)) {
        stairs[key(info.x, info.y)] = { bottom: info.lo, top: info.hi, kind: info.kind ? info.kind.label : null, airlock: !!info.airlock };
      }
      const errors = an.warnings.filter(w => w.kind === 'error').length;
      file.grids[uid].resolved = { errors, quarters, stairs };
    }
    return { file, staleVis, sha };
  }
  async function save() {
    const src = env.mapSource();
    if (!src) { env.toast('Open a map first', true); return; }
    const { file, staleVis } = await buildFile();
    const all = [...analysis.values()].flatMap(a => a.warnings);
    const errors = all.filter(w => w.kind === 'error').length, checks = all.length - errors;
    env.download(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }), env.safeName(mapBaseName()) + '.levels.json');
    env.toast((all.length ? `Saved with ${errors} error${errors === 1 ? '' : 's'} and ${checks} to check` : 'Saved, no warnings')
      + (staleVis ? '. Visibility left out: the rooms changed since it was baked' : ''), !!staleVis);
  }
  // ---- export chosen rooms: the map cut down to their tiles (.yml, original text with lines cut out) and
  // the matching part of the levels file, with the full file's room ids, names and visibility
  const exportSel = new Map();                 // uid -> Set(room ids)
  function toggleExportRoom(uid, id) {
    for (const u of [...exportSel.keys()]) if (u !== uid) exportSel.delete(u);   // one grid at a time
    const set = exportSel.get(uid) || new Set();
    if (set.has(id)) set.delete(id); else set.add(id);
    if (set.size) exportSel.set(uid, set); else exportSel.delete(uid);
  }
  function subsetGrid(g, tiles) {
    const out = {};
    const inT = (k) => tiles.has(k);
    for (const [name, v] of Object.entries(g)) {
      if (['floor', 'roof', 'cuts', 'subcuts', 'stairs', 'cut_levels', 'stair_levels', 'rooms', 'room_parts'].includes(name)) {
        const o = {}; for (const [k, val] of Object.entries(v)) if (inT(k)) o[k] = val; out[name] = o;
      } else if (name === 'edges') {
        out.edges = v.filter(e => { const nk = e.side === 'E' ? key(e.x + 1, e.y) : key(e.x, e.y + 1); return inT(key(e.x, e.y)) || inT(nk); });
      } else if (name === 'room_space_tiles') {
        out.room_space_tiles = v.filter(inT);
      } else if (name === 'resolved') {
        const q = {}, st = {};
        for (const [k, val] of Object.entries(v.quarters || {})) if (inT(k)) q[k] = val;
        for (const [k, val] of Object.entries(v.stairs || {})) if (inT(k)) st[k] = val;
        out.resolved = { errors: v.errors, quarters: q, stairs: st };
      } else if (name === 'tile_visibility') {
        const t = {}; for (const [k, i] of Object.entries(v.tiles || {})) if (inT(k)) t[k] = i;
        out.tile_visibility = { sets: v.sets, tiles: t };
      } else out[name] = v;                    // room_names, room_no_hull, visibility: exactly as in the full file
    }
    for (const name of ['subcuts', 'cut_levels', 'stair_levels', 'room_parts']) if (out[name] && !Object.keys(out[name]).length) delete out[name];
    if (out.room_space_tiles && !out.room_space_tiles.length) delete out.room_space_tiles;
    return out;
  }
  async function exportRooms() {
    const src = env.mapSource();
    const [uid, set] = [...exportSel][0] || [];
    if (!src || !set || !set.size) { env.toast('Shift+click rooms on the map to choose them first', true); return; }
    const R = roomsOf(uid), ids = [...set].filter(id => R.byId.has(id)).sort((a, b) => a - b);
    const tiles = new Set();
    for (const id of ids) for (const k of R.byId.get(id).tiles) tiles.add(k);
    try {
      env.toast(`Exporting ${ids.length} room${ids.length === 1 ? '' : 's'}…`);
      const res = await exportSelection({ text: src.text, gridUid: +uid, tiles, keepTiles: true, keepDecals: true });
      const { file, staleVis, sha } = await buildFile([uid]);
      const part = { ...file, grids: {}, source: { map: String(src.name || 'map.yml').split('/').pop(), map_sha1: sha || '', rooms: ids } };
      part.map = String(src.name || 'map.yml').split('/').pop().replace(/\.ya?ml$/i, '') + '-rooms.yml';
      if (file.grids[uid]) part.grids[uid] = subsetGrid(file.grids[uid], tiles);
      const names = ids.map(id => R.byId.get(id).name).filter(Boolean);
      const base = env.safeName(mapBaseName() + '-' + (names.length === ids.length && names.length <= 3 ? names.join('-') : 'rooms-' + ids.join('-')).slice(0, 80));
      // the chunk's own sha1, so the levels file matches it
      part.map = base + '.yml';
      part.map_sha1 = (await sha1(res.text)) || '';
      env.download(new Blob([res.text], { type: 'text/yaml' }), base + '.yml');
      setTimeout(() => env.download(new Blob([JSON.stringify(part, null, 2) + '\n'], { type: 'application/json' }), base + '.levels.json'), 400);
      env.toast(`Exported ${ids.length} room${ids.length === 1 ? '' : 's'}: ${res.entities} entities, ${res.tiles} floor tiles, ${res.decals} decals` + (staleVis ? '. Visibility left out: it is stale' : ''), !!staleVis);
    } catch (e) { env.toast('Export failed: ' + e.message, true); }
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
    // visibility from the file belongs to the rooms in the file, so it counts as current
    vis.clear(); ver++;
    for (const uid of Object.keys(j.grids || {})) {
      const g = j.grids[uid];
      if (!g.visibility) continue;
      const num = (n) => n === 'outside' ? 0 : +n;
      const v = { sig: visSig(uid), rooms: new Map(), tiles: new Map() };
      for (const [id, list] of Object.entries(g.visibility)) if (id !== 'outside') v.rooms.set(num(id), new Set(list.map(num)));
      const tv = g.tile_visibility;
      if (tv && tv.sets && tv.tiles) for (const [k, i] of Object.entries(tv.tiles)) if (tv.sets[i]) v.tiles.set(k, new Set(tv.sets[i].map(num)));
      vis.set(uid, v);
    }
    saveVis();
    stripWallRoofs();
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
    fileNote = ''; mapSha1 = null; ui.roomSel = null; roomCache.clear(); exportSel.clear();
    if (bake) { bake.workers.forEach(w => w.terminate()); bake = null; }
    loadVisLocal();
    const saved = env.lsGet('levels2.' + env.mapKey()) || env.lsGet('levels.' + env.mapKey());
    if (saved) doc.restore(saved);
    if (saved && !env.lsGet('levelsFloorReset1.' + env.mapKey())) {
      env.lsSet('levelsFloorReset1.' + env.mapKey(), 1);
      doc.snapshot();
      const n = resetFloors();
      if (n) { try { env.lsSet('levels2.' + env.mapKey(), doc.serialize()); } catch (e) { /* ignore */ } setTimeout(() => env.toast(`Floor levels reset on this map (${n}), as asked. Ctrl+Z brings them back.`), 500); }
      else doc.undoStack.pop();
    }
    const src = env.mapSource();
    if (src) sha1(src.text).then(s => { mapSha1 = s; });
    reanalyse();
    renderPane();
  }
  function sceneReady() { cache = { scene: null, map: new Map() }; roomCache.clear(); reanalyse(); renderPane(); env.redraw(); stripWallRoofs(); }

  // ---- the pane
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function exportHtml(sr) {
    const [uid, set] = [...exportSel][0] || [];
    const R = uid != null ? roomsOf(uid) : null;
    const ids = set ? [...set].filter(id => R.byId.has(id)).sort((a, b) => a - b) : [];
    return `
      <h4>Export rooms <span class="lvcount">${ids.length} chosen</span></h4>
      <p class="hint"><b>Shift+click</b> rooms to choose them (blue). Exports the map with only their tiles (<b>.yml</b>, same coordinates and grid, the original text with the rest cut out) and the matching <b>.levels.json</b> with the same room ids, names and visibility, plus where it came from.</p>
      ${ids.length ? `<div class="lvvislist">${ids.map(id => `<span class="lvvis"><i style="background:${roomColor(id)}"></i>#${id}${R.byId.get(id).name ? ' ' + esc(R.byId.get(id).name) : ''}</span>`).join('')}</div>` : ''}
      <div class="row gap wrap">
        <button class="btn small primary" id="lvExpRooms" ${ids.length ? '' : 'disabled'}>Export ${ids.length || ''} room${ids.length === 1 ? '' : 's'}</button>
        <button class="btn small" id="lvExpClear" ${ids.length ? '' : 'disabled'}>Clear choice</button>
      </div>`;
  }
  function visHtml(sr) {
    const uids = gridUids().filter(u => roomsOf(u).list.length);
    let baked = 0, total = 0, stale = false;
    for (const u of uids) { total += roomsOf(u).list.length; const st = visState(u); if (st.v) { baked += st.v.rooms.size; stale = stale || st.stale; } }
    let selInfo = '';
    if (sr) {
      const st = visState(ui.roomSel.uid), seen = st.v && !st.stale ? st.v.rooms.get(sr.room.id) : null;
      selInfo = seen ? `<p class="hint">Room #${sr.room.id} sees ${seen.size} room${seen.size === 1 ? '' : 's'}${seen.has(0) ? ', including Outside' : ''}; they are lit on the map, everything else is dimmed.</p>` : '';
    }
    return `
      <h4>Visibility <span class="lvcount">${stale ? 'stale' : `${baked} of ${total} baked`}</span></h4>
      <p class="hint">What each room can see, for Unity: ${VIS_N}×${VIS_N} eye points on every tile that doesn’t block sight, almost to the tile corners. Walls and other occluders stop sight (a wall’s face doesn’t count); doors count as open; windows, grilles and space don’t block. Levels are ignored.</p>
      ${stale ? '<p class="lvnote">The rooms or walls changed since visibility was baked. Bake again; stale visibility isn’t saved.</p>' : ''}
      ${bake ? `<div class="row gap"><span class="hint">Baking ${bake.rooms} room${bake.rooms === 1 ? '' : 's'}… ${bake.done} of ${bake.total} tiles (${bake.eyes.toLocaleString()} eye points)</span><button class="btn small" id="lvVisCancel">Cancel</button></div>`
        : `<div class="row gap wrap">
        <button class="btn small" id="lvVisOne" ${sr ? '' : 'disabled'}>Bake ${sr ? 'room #' + sr.room.id : 'the selected room'}</button>
        <button class="btn small" id="lvVisAll" ${total ? '' : 'disabled'}>Bake all ${total} rooms</button></div>`}
      ${selInfo}
      <label class="row tglbtn"><input type="checkbox" id="lvVisCheck" ${ui.visCheck ? 'checked' : ''}> Check what each tile sees</label>
      ${ui.visCheck ? `<p class="hint">Point at a tile (click to hold it): rooms not in its list are hidden, and the view from the cursor (or the held tile’s centre) is lit yellow, following the mouse.</p><div id="lvVisList"></div>` : ''}`;
  }
  function roomsHtml() {
    const sr = selRoom();
    let total = 0, named = [];
    for (const uid of gridUids()) { const R = roomsOf(uid); total += R.list.length; for (const r of R.list) if (r.name) named.push({ uid, r }); }
    named.sort((a, b) => a.r.name.localeCompare(b.r.name));
    return `
      <h4>Rooms <span class="lvcount">${total} rooms, ${named.length} named</span></h4>
      ${sr ? `<div class="lvroomsel"><b>Room #${sr.room.id}</b> · ${sr.room.size} tiles
        <div class="row gap"><input id="lvRoomName" type="text" maxlength="60" placeholder="Name, e.g. Bridge" value="${esc(sr.room.name || '')}">
        <button class="btn small primary" id="lvRoomSet">Set</button><button class="btn small" id="lvRoomClr" ${sr.room.name ? '' : 'disabled'}>Remove name</button></div>
        <label class="row tglbtn"><input type="checkbox" id="lvNoHull" ${sr.room.noHull ? 'checked' : ''}> Not part of the hull</label></div>`
        : '<p class="hint">Click a room on the map to name it. Enter sets the name.</p>'}
      <p class="hint">Rooms are made only by your main cuts: everything inside a closed cut is that room, floor, walls, lattice and space alike. The rest of the station is one room; space outside it is Outside. Subcuts don’t split rooms. A name stays with the room when cuts change elsewhere.</p>
      ${exportHtml(sr)}
      ${visHtml(sr)}
      ${named.length ? `<div class="lvrooms">${named.map(({ uid, r }) => `<button class="lvroom" data-g="${esc(uid)}" data-r="${r.id}"><i style="background:${roomColor(r.id)}"></i>${esc(r.name)} <small>#${r.id}, ${r.size}</small></button>`).join('')}</div>` : ''}`;
  }
  function renderPane() {
    const p = env.pane;
    if (!p) return;
    const all = [];
    for (const [uid, a] of analysis) for (const w of a.warnings) all.push({ ...w, uid });
    all.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'error' ? -1 : 1));
    const errors = all.filter(w => w.kind === 'error').length, checks = all.length - errors;
    let nf = 0, nr = 0, cuts = 0, edges = 0, stairs = 0, set = 0, sset = 0, air = 0;
    for (const d of doc.grids.values()) { nf += d.floor.size; nr += d.roof.size; cuts += d.cuts.size; edges += halvesOf(d.edges).size; stairs += d.stairs.size; set += d.cutLevels.size; sset += d.stairLevels.size; }
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
        ${modeBtn('paint', 'Paint level', 'Drag to paint floor tiles in the chosen layer; Shift+drag paints a rectangle. With the 1×1 brush: on a cut tile it sets the part under the cursor by hand, on stairs it sets the bottom step (floor layer) or the stairs’ roof (roof layer). The roof layer starts at 0.')}
        ${modeBtn('cut', 'Cut tile', 'Click places the chosen shape exactly; drag places it on every tile you pass. R turns the shape. Alt+click near an edge of a cut tile adds or removes that arm.')}
        ${modeBtn('clear', 'Clear set part', 'Click a part of a cut tile to put it back to worked out (this layer), or stairs to unset the bottom step. Right-click does the same in any mode.')}
        ${modeBtn('fill', '🪣 Floor fill bucket', 'Fill bucket for floors: click a tile and the floor level spreads over every tile it can reach, walls, windows and doors included, until it meets a cut (main or sub, middle or edge) or space. Cut tiles and stairs keep following their neighbours.')}
        ${modeBtn('connect', 'Dot cut', 'Click a tile centre, the middle of a tile side, or a tile corner to put a dot there. It joins itself to the cuts and dots next to it (also across one free point in a straight line). Click dots one after another, or drag, to draw a cut. Alt+click or Alt+drag removes the cut pieces at those points.')}
        ${modeBtn('edge', 'Edge cut', 'Click next to a tile edge to cut exactly on that edge, whole or half (click again to remove). A half edge cut meets a middle cut at the edge.')}
        ${modeBtn('stairs', 'Stairs', 'Click a tile to make it stairs. Auto points them uphill; clicking again turns them. Alt+click removes. To cut through stairs, place a cut tile on them.')}
        ${modeBtn('erase', 'Eraser', 'Drag to remove cut tiles, stairs and edge cuts, and to unassign the level in this layer.')}
        ${modeBtn('auto', 'Auto cuts', 'Drag over where floors change: adds edge cuts or middle cuts wherever different floors touch with no cut yet. Fix any wrong ones with the other tools.')}
        ${modeBtn('rooms', 'Rooms', 'Shows the rooms made by your main cuts (subcuts don’t split them). Click a room to name it, and bake what each room can see.')}
      </div>
      ${ui.mode === 'auto' ? `
      <h4>Automatic cuts</h4>
      <div class="row gap">${opt('autoKind', 'edge', 'Edge cuts (on tile edges)', ui.autoKind)}${opt('autoKind', 'middle', 'Middle cuts (through tiles)', ui.autoKind)}</div>
      <p class="hint">${ui.autoKind === 'edge'
        ? 'Drag with the brush: every half edge where two different floors touch with no cut gets an edge cut.'
        : 'Drag with the brush: a floor tile next to a different floor becomes a cut tile (straight or corner, from the floors around it). Where two such tiles touch, the higher one is cut. Run Edge cuts afterwards to close any gaps a middle cut can’t.'}
        Placed as ${ui.tier === 'sub' ? 'subcuts' : 'main cuts'}; the brush size is below.</p>
      <button class="btn small" id="lvAutoAll">${ui.autoKind === 'edge' ? 'Add edge cuts' : 'Add middle cuts'} everywhere on the map</button>` : ''}
      ${ui.mode === 'rooms' ? roomsHtml() : ''}
      ${ui.mode === 'cut' ? `
      <h4>Cut shape <span class="lvcount">R turns it</span></h4>
      <div class="lvshapes">${SHAPES.map(([grp, list]) => `<div class="lvsgrp"><small>${grp}</small><div>${list.map(sh => `<button class="lvshape${ui.shape === sh ? ' on' : ''}" data-s="${sh}" title="${sh}">${shapeSvg(sh)}</button>`).join('')}</div></div>`).join('')}</div>
      <label class="row tglbtn" title="When on, a placed cut tile also joins neighbouring cut tiles and stairs (never walls, windows, doors or plain tiles)"><input type="checkbox" id="lvJoin" ${ui.autoJoin ? 'checked' : ''}> Join to neighbouring cuts and stairs</label>` : ''}
      ${ui.mode === 'cut' || ui.mode === 'edge' || ui.mode === 'auto' || ui.mode === 'connect' ? `<h4>Cut tier</h4><div class="row gap">${opt('tier', 'main', 'Main cut (splits rooms)', ui.tier)}${opt('tier', 'sub', 'Subcut (height step inside a room)', ui.tier)}</div>` : ''}
      ${ui.mode === 'edge' ? `<h4>Edge cut length</h4><div class="row gap">${opt('edgeLen', 'full', 'Whole edge', ui.edgeLen)}${opt('edgeLen', 'half', 'Half edge (meets a middle cut)', ui.edgeLen)}</div>` : ''}
      <h4>${L} level</h4>
      <div class="lvlevels">${LEVELS.map(v => `<button class="lvlv${!ui.clearLv && ui.level === v ? ' on' : ''}" data-v="${v}" style="--c:${levelColor(v)}">${v === 0 ? '0' : fmt(v)}</button>`).join('')}<button class="lvlv${ui.clearLv ? ' on' : ''}" data-v="clear" style="--c:#ffffff" title="Clear: paint and fill take the level away (unassigned)">✕</button></div>
      <div class="row gap">
        <label class="row">Brush ${[1, 3, 5, 9].map(b => `<button class="btn small lvbrush${ui.brush === b ? ' on' : ''}" data-b="${b}">${b}×${b}</button>`).join('')}</label>
      </div>
      <button class="btn small" id="lvArea" ${area && area.tiles && area.tiles.size ? '' : 'disabled'}>Set ${L.toLowerCase()} ${lvText()} on the Area selection${area && area.tiles && area.tiles.size ? ` (${area.tiles.size} tiles)` : ''}</button>
      <h4>Stairs rise</h4>
      <div class="row gap">${opt('stairDir', 'auto', 'Auto', ui.stairDir)}${['N', 'E', 'S', 'W'].map(dd => opt('stairDir', dd, dd, ui.stairDir)).join('')}</div>
      <p class="lvhover" id="lvHover"></p>
      <h4>Legend</h4>
      <div class="lvlegend">
        ${LEVELS.map(v => `<span><i style="background:${levelColor(v)}"></i>${v === 0 ? '0' : fmt(v)}</span>`).join('')}
        <span><i class="unsw"></i>unassigned (counts as 0)</span>
        <span><i class="cutsw"></i>main cut (splits rooms)</span>
        <span><i class="subsw"></i>subcut (inside a room)</span>
        <span><i class="hatchsw"></i>cut part, worked out</span>
        <span><i class="stubf"></i>floor stub (lower floor’s side)</span>
        <span><i class="stubr"></i>roof stub (higher roof’s side)</span>
        <span><i class="errsw"></i>floors touching</span>
        <span><i class="airsw"></i>stairs in an airlock</span>
        <span>“· cut”: stairs cut through</span>
      </div>
      <p class="hint">Stairs: 1 level small, 2 steep, 3–4 a ladder. Walls, windows and doors have a floor level but no roof.</p>
      <h4>Warnings <span class="lvcount">${errors} error${errors === 1 ? '' : 's'}, ${checks} to check</span></h4>
      <div class="lvwarn">${all.length ? all.slice(0, 300).map((w, i) => `<button class="lvw ${w.kind}" data-i="${i}">${w.kind === 'check' ? 'Check: ' : ''}${esc(w.msg)} <small>(${Math.floor(w.x)}, ${Math.floor(w.y)})</small></button>`).join('') + (all.length > 300 ? `<p class="hint">…and ${all.length - 300} more</p>` : '') : '<p class="hint">None.</p>'}</div>
      <h4>File</h4>
      <p class="hint">${nf} floor and ${nr} roof tiles assigned, ${cuts} cut tiles (${set} with parts set by hand), ${edges} edge cuts, ${stairs} stairs${sset ? ` (${sset} with a set bottom step)` : ''}${air ? `, ${air} in an airlock` : ''}.</p>
      <div class="row gap wrap">
        <button class="btn primary small" id="lvSave">Save .levels.json</button>
        <button class="btn small" id="lvOpen">Open .levels.json</button>
        <button class="btn small" id="lvUnset" ${set ? '' : 'disabled'} title="Every cut part set by hand goes back to following the floors next to it">Unset hand-set cut parts</button>
        <button class="btn small" id="lvResetFloor" title="Removes every floor level (and hand-set floor parts of cut tiles); roofs, cuts and stairs stay">Reset floor levels</button>
        <button class="btn small" id="lvClear">Clear all</button>
        <input type="file" id="lvFile" accept=".json,application/json" hidden>
      </div>`;
    p.querySelector('#lvShow').onchange = (e) => { ui.show = e.target.checked; env.redraw(); };
    p.querySelector('#lvOnly').onchange = (e) => { ui.onlyMarks = e.target.checked; env.redraw(); };
    p.querySelectorAll('.lvmode').forEach(b => b.onclick = () => { ui.mode = b.dataset.m; if (ui.mode === 'fill' && ui.layer !== 'floor') { ui.levelMem.roof = ui.level; ui.layer = 'floor'; ui.level = ui.levelMem.floor; } env.setTool('levels'); renderPane(); });
    p.querySelectorAll('.lvopt').forEach(b => b.onclick = () => {
      if (b.dataset.o === 'layer' && b.dataset.v !== ui.layer) { ui.levelMem[ui.layer] = ui.level; ui.level = ui.levelMem[b.dataset.v]; }
      ui[b.dataset.o] = b.dataset.v; renderPane(); env.redraw();
    });
    p.querySelectorAll('.lvshape').forEach(b => b.onclick = () => { ui.shape = b.dataset.s; ui.mode = 'cut'; env.setTool('levels'); renderPane(); });
    const join = p.querySelector('#lvJoin'); if (join) join.onchange = (e) => { ui.autoJoin = e.target.checked; };
    p.querySelectorAll('.lvlv').forEach(b => b.onclick = () => { if (b.dataset.v === 'clear') ui.clearLv = true; else { ui.clearLv = false; ui.level = +b.dataset.v; } if (ui.mode !== 'paint' && ui.mode !== 'fill' && ui.mode !== 'rooms') ui.mode = 'paint'; env.setTool('levels'); renderPane(); });
    p.querySelectorAll('.lvbrush').forEach(b => b.onclick = () => { ui.brush = +b.dataset.b; renderPane(); });
    p.querySelector('#lvArea').onclick = applyToArea;
    p.querySelectorAll('.lvw').forEach(b => b.onclick = () => { const w = all[+b.dataset.i]; env.jumpTo(w.uid, w.x, w.y); });
    p.querySelector('#lvSave').onclick = save;
    const fi = p.querySelector('#lvFile');
    p.querySelector('#lvOpen').onclick = () => fi.click();
    fi.onchange = async () => { const f = fi.files[0]; fi.value = ''; if (f && !(await loadFile(f))) env.toast('That is not a levels file', true); };
    const aa = p.querySelector('#lvAutoAll'); if (aa) aa.onclick = autoEverywhere;
    p.querySelector('#lvUnset').onclick = () => {
      doc.snapshot();
      for (const d of doc.grids.values()) d.cutLevels.clear();
      changed(); env.toast('Cut parts follow the floors next to them again');
    };
    const rn = p.querySelector('#lvRoomName');
    if (rn) {
      rn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameRoom(rn.value); } else if (e.key === 'Escape') { ui.roomSel = null; renderPane(); env.redraw(); } };
      p.querySelector('#lvRoomSet').onclick = () => nameRoom(rn.value);
      p.querySelector('#lvRoomClr').onclick = () => nameRoom('');
    }
    p.querySelectorAll('.lvrt').forEach(b => b.onclick = () => { ui.roomTool = b.dataset.t; renderPane(); env.redraw(); });
    const nh = p.querySelector('#lvNoHull'); if (nh) nh.onchange = (e) => setNoHull(e.target.checked);
    const xr = p.querySelector('#lvExpRooms'); if (xr) xr.onclick = exportRooms;
    const xc = p.querySelector('#lvExpClear'); if (xc) xc.onclick = () => { exportSel.clear(); renderPane(); env.redraw(); };
    const vck = p.querySelector('#lvVisCheck'); if (vck) vck.onchange = (e) => { ui.visCheck = e.target.checked; ui.visLock = null; renderPane(); env.redraw(); };
    if (ui.visCheck) renderVisList();
    const v1 = p.querySelector('#lvVisOne'); if (v1) v1.onclick = () => { const sr = selRoom(); if (sr) bakeRooms(ui.roomSel.uid, [sr.room.id]); };
    const va = p.querySelector('#lvVisAll'); if (va) va.onclick = () => { for (const u of gridUids()) { const R = roomsOf(u); if (R.list.length) { bakeRooms(u, R.list.map(r => r.id)); break; } } };
    const vc = p.querySelector('#lvVisCancel'); if (vc) vc.onclick = cancelBake;
    p.querySelectorAll('.lvroom').forEach(b => b.onclick = () => {
      const uid = b.dataset.g, r = roomsOf(uid).byId.get(+b.dataset.r);
      if (!r) return;
      const k = [...r.tiles][0], R = roomsOf(uid);
      const qi = R.tileRoom.has(k) ? 0 : R.partRoom.get(k).indexOf(r.id);
      ui.roomSel = { uid, anchor: k + '#' + qi };
      env.jumpTo(uid, r.lx, r.ly); renderPane(); env.redraw();
    });
    p.querySelector('#lvResetFloor').onclick = () => {
      doc.snapshot();
      const n = resetFloors();
      if (!n) { doc.undoStack.pop(); env.toast('No floor levels to reset'); return; }
      changed(); env.toast(`Floor levels reset (${n}); Ctrl+Z brings them back`);
    };
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
