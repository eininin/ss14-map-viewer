// Turns a parsed map + sprite database into drawable items, and renders them.
import { texRel } from './packs.js';

export const PX = 32;          // pixels per tile in RSIs
export const CHUNK = 16;       // tiles per render chunk

// every layer can be shown on its own
export const LAYER_KEYS = ['tiles', 'decals',
  'atmos', 'atmosdev', 'hv', 'mv', 'lv', 'power', 'disposal', 'disposaldev',
  'walls', 'doors', 'wallmount', 'computers', 'fabrication', 'vending', 'machines',
  'storage', 'furniture', 'items', 'other', 'markers'];
// pipes and cables themselves (drawn on top in "on top" mode)
export const NET_CATS = new Set(['atmos', 'hv', 'mv', 'lv', 'disposal']);
export const DEFAULT_OPTS = Object.assign(Object.fromEntries(LAYER_KEYS.map(k => [k, true])), {
  markers: false, allLayers: false,
  pipeMode: 'game',   // 'game': hidden under floor tiles like in game · 'top': drawn over everything
});

// layers that the game hides at runtime (visualizers), shown only when "all layers" is on
const HIDE_LAYER = /Welded|Bolted|Emergency|MaintenancePanel|Emag|Electrified|PanelLock|InterfaceLock|Deconstruction|Sparks|Unlit/i;

const DIR4 = [0, 2, 1, 3];                 // quarter turn index (S,E,N,W) -> RSI dir index
const DIR8 = [0, 4, 2, 6, 1, 7, 3, 5];     // eighth turn (S,SE,E,NE,N,NW,W,SW) -> RSI dir index
const TAU = Math.PI * 2;

const tkey = (g, x, y) => g + ':' + x + ',' + y;

// atmos pipe directions are a 4-bit mask: North 1, South 2, West 4, East 8
const PIPE_STEPS = [[1, 0, 1, 2], [2, 0, -1, 1], [4, -1, 0, 8], [8, 1, 0, 4]];   // bit, dx, dy, opposite bit
const CONNECTOR_FRAME = { 1: 1, 2: 0, 4: 3, 8: 2 };                               // bit -> RSI dir (S0 N1 E2 W3)
function rotateMask(m, rot) {
  const q = ((Math.round(rot / (Math.PI / 2)) % 4) + 4) % 4;   // quarter turns counter-clockwise
  for (let i = 0; i < q; i++) {
    let n = 0;
    if (m & 1) n |= 4;   // N -> W
    if (m & 4) n |= 2;   // W -> S
    if (m & 2) n |= 8;   // S -> E
    if (m & 8) n |= 1;   // E -> N
    m = n;
  }
  return m;
}
const PIPE_LAYER_NAMES = { primary: 0, secondary: 1, tertiary: 2, quaternary: 3, quinary: 4 };
function pipeLayerIndex(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return +s;
  return PIPE_LAYER_NAMES[s] != null ? PIPE_LAYER_NAMES[s] : null;
}

export function buildScene(model, db, opts) {
  const items = [];          // entities + decals
  const tiles = new Map();   // gridUid -> [{x,y,name,v,rm}]
  const subfloor = new Map();// tile key -> bool
  const needs = [];          // [{kind:'state'|'tex', rsi, state, path}] used for loading
  const needSet = new Set();
  const need = (o) => {
    const k = o.tex ? 't|' + o.tex : 's|' + texRel(o.rsi) + '|' + o.state;
    if (!needSet.has(k)) { needSet.add(k); needs.push(o); }
  };
  const unknownProtos = new Map();

  // ---- tiles
  for (const g of model.grids) {
    const list = [];
    for (const ch of g.chunks) {
      const n = ch.size;
      for (let i = 0; i < n * n; i++) {
        const id = ch.ids[i];
        const name = model.tilemap[id];
        if (!name || name === 'Space') continue;
        const x = ch.cx * n + (i % n), y = ch.cy * n + Math.floor(i / n);
        const td = db.tile[name] || (db.tileAlias && db.tile[db.tileAlias[name]]);
        list.push({ x, y, name, v: ch.vari[i], rm: ch.rm[i], td });
        subfloor.set(tkey(g.uid, x, y), !!(td && td.sub));
        if (td && td.s) need({ tex: td.s });
      }
    }
    tiles.set(g.uid, list);
  }

  // old prototype ids are renamed (or deleted) the way the game does it on load
  const mig = db.migrate || {};
  const lookup = (p) => {
    if (db.ent[p]) return { proto: p, info: db.ent[p] };
    if (Object.prototype.hasOwnProperty.call(mig, p)) {
      const to = mig[p];
      if (to == null) return { deleted: true };
      if (db.ent[to]) return { proto: to, info: db.ent[to], from: p };
    }
    return { proto: p, info: null };
  };
  const ents = [];
  for (const e of model.ents) {
    const r = lookup(e.proto);
    if (r.deleted) continue;
    ents.push(r.from ? { ...e, proto: r.proto, renamedFrom: r.from } : e);
  }

  // ---- neighbour index for smoothing / cables
  const smoothAt = new Map();  // tile key -> Set(keys)
  const cableAt = new Map();   // tile key -> Set(prefix)
  for (const e of ents) {
    const info = db.ent[e.proto];
    if (!info) continue;
    const k = tkey(e.grid, Math.floor(e.x), Math.floor(e.y));
    if (info.sm) { if (!smoothAt.has(k)) smoothAt.set(k, new Set()); smoothAt.get(k).add(info.sm[0]); }
    if (info.cab) { if (!cableAt.has(k)) cableAt.set(k, new Set()); cableAt.get(k).add(info.cab[0]); }
  }
  const sets = db.sets || [];
  const pipeAt = new Map();   // tile key + '|' + pipe layer -> [world masks]
  const entPipe = new Map();  // entity -> {layer, nodes: [{world, layer}]}
  for (const e of ents) {
    const info = db.ent[e.proto];
    if (!info || !info.pd) continue;
    let layer = info.pl || 0;
    const ov = pipeLayerIndex(e.pl);
    if (ov != null) layer = ov;
    // most pipes have all their nodes on the entity's layer; manifolds have one per layer
    const nodes = info.pn ? info.pn.map(([m, l]) => ({ world: rotateMask(m, e.rot), layer: l != null ? l : layer }))
      : [{ world: rotateMask(info.pd, e.rot), layer }];
    entPipe.set(e, { layer, nodes });
    for (const n of nodes) {
      const k = tkey(e.grid, Math.floor(e.x), Math.floor(e.y)) + '|' + n.layer;
      if (!pipeAt.has(k)) pipeAt.set(k, []);
      pipeAt.get(k).push(n.world);
    }
  }
  // catwalks: devices sitting on them keep only their visible part, like on a floor
  const catwalkAt = new Set();
  for (const e of ents) { const info = db.ent[e.proto]; if (info && info.cw) catwalkAt.add(tkey(e.grid, Math.floor(e.x), Math.floor(e.y))); }

  const smoothMatch = (sm, g, x, y) => {
    const s = smoothAt.get(tkey(g, x, y));
    if (!s) return false;
    if (s.has(sm[0])) return true;
    for (const a of sm[3] || []) if (s.has(a)) return true;
    return false;
  };

  // ---- entities
  for (const e of ents) {
    const info = db.ent[e.proto];
    const tx = Math.floor(e.x), ty = Math.floor(e.y);
    const it = {
      kind: 'ent', uid: e.uid, proto: e.proto, grid: e.grid, x: e.x, y: e.y, rot: e.rot,
      name: e.name || (info && info.n) || e.proto, depth: 0, layers: [], tx, ty,
    };
    if (e.renamedFrom) it.renamedFrom = e.renamedFrom;
    if (!info) {
      unknownProtos.set(e.proto, (unknownProtos.get(e.proto) || 0) + 1);
      it.unknown = true;
      it.layers.push({ dev: true });
      it.depth = 0;
      items.push(it);
      continue;
    }
    it.info = info;
    if (info.cat) it.cat = info.cat;
    it.depth = info.d != null ? info.d : 0;
    if (info.mk) it.marker = true;
    if (info.sub) it.sub = true;
    if (info.v === 0 && !info.sub) it.hiddenSprite = true;
    let rot = e.rot + (info.r || 0);
    if (info.snap) rot = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
    it.rot = rot;
    it.noRot = !!info.nr;
    it.offset = info.o || null;
    it.scale = info.sc || null;

    // layer list as the sprite component defines it
    const src = [];
    if (info.l) {
      // with explicit layers the sprite-level state is not used (as in the engine)
      for (const l of info.l) src.push(l);
    } else {
      src.push({ st: info.st, t: info.t });
    }
    const base = info.s;
    let layers = src.map((l) => ({
      rsi: l.s || base, state: l.st != null ? l.st : null, tex: l.t || null,
      color: l.c || info.c || null, offset: l.o || null, scale: l.sc || null, lrot: l.r || 0,
      hidden: l.v === 0, runtimeHidden: !!(l.m && l.m.some(m => HIDE_LAYER.test(m))),
      map: l.m || null, shader: l.sh || null,
    }));

    // doors: the map can override the prototype's open/closed state
    const doorState = e.door || info.door;
    if (doorState === 'open') {
      it.door = 'open';
      if (info.dod != null) it.depth = info.dod;
      for (const l of layers) if (l.map && l.map.some(m => /DoorVisualLayers\.Base$/.test(m))) l.state = 'open';
    }

    // atmos pipe layer: each layer has its own RSI (the pipe is drawn off-centre)
    const pinfo = entPipe.get(e);
    if (pinfo && pinfo.layer) {
      const pl = pinfo.layer;
      if (info.prs != null && sets[info.prs] && sets[info.prs][pl]) {
        const r = sets[info.prs][pl];
        layers = layers.map((l, i) => (src[i] && !src[i].s) ? { ...l, rsi: r } : l);
      }
      if (info.plr) for (const l of layers) {
        if (!l.map) continue;
        for (const mk of l.map) if (info.plr[mk] != null && sets[info.plr[mk]] && sets[info.plr[mk]][pl]) l.rsi = sets[info.plr[mk]][pl];
      }
    }

    // pipe colour from the map file (or the prototype's default)
    const pipeColor = e.pipe || info.pc || null;
    if (pipeColor) {
      let any = false;
      for (const l of layers) if (l.map && l.map.some(m => /Pipe/i.test(m))) { l.color = pipeColor; any = true; }
      if (!any && e.pipe && layers.length) layers[0].color = pipeColor;
    }

    // placed (anchored) and loose looks
    const anchored = e.anch != null ? e.anch : (info.anc ? true : !!(info.anv || info.pa != null));
    const applyAnchor = (ls, which) => {
      const m = info.anv && info.anv[which];
      if (!m) return ls;
      return ls.map(l => {
        if (!l.map) return l;
        for (const mk of l.map) if (m[mk]) {
          const d = m[mk];
          l = { ...l };
          if (d.st != null) l.state = d.st;
          if (d.v != null) { l.hidden = d.v === 0; if (d.v === 1) l.runtimeHidden = false; }
        }
        return l;
      });
    };
    const loose = applyAnchor(layers.map(l => ({ ...l })), '0');
    let placed = applyAnchor(layers.map(l => ({ ...l })), '1');
    // atmos pipes show a connector toward every neighbour they join on the same pipe layer
    if (pinfo && info.pa != null && sets[info.pa]) {
      const add = [];
      const done = new Set();
      for (const node of pinfo.nodes) {
        const conn = sets[info.pa][Math.min(node.layer, sets[info.pa].length - 1)] || sets[info.pa][0];
        for (const [bit, dx, dy, opp] of PIPE_STEPS) {
          if (!(node.world & bit)) continue;
          const key = node.layer + ':' + bit;
          if (done.has(key)) continue;
          const list = pipeAt.get(tkey(e.grid, tx + dx, ty + dy) + '|' + node.layer);
          if (!list || !list.some(m => m & opp)) continue;
          done.add(key);
          add.push({ rsi: conn[0], state: conn[1], fixedDir: CONNECTOR_FRAME[bit], color: pipeColor,
            offset: info.o ? [-info.o[0], -info.o[1]] : null, connector: true });
        }
      }
      if (add.length) {
        let at = placed.findIndex(l => l.map && l.map.some(m => /PipeVisualLayers\.Pipe$/.test(m)));
        at = at < 0 ? placed.length : at + 1;
        placed = [...placed.slice(0, at), ...add, ...placed.slice(at)];
      }
    }
    const differs = JSON.stringify(placed.map(l => [l.rsi, l.state, l.hidden])) !== JSON.stringify(loose.map(l => [l.rsi, l.state, l.hidden]));
    layers = anchored ? placed : loose;
    if (differs) {
      it.alt = { label: anchored ? 'Not placed (loose)' : 'Placed (anchored)', layers: anchored ? loose : placed };
      it.placedLabel = anchored ? 'Placed (as on the map)' : 'Loose (as on the map)';
      for (const l of it.alt.layers) {
        if (l.tex) need({ tex: l.tex });
        else if (l.rsi && l.state != null) need({ rsi: l.rsi, state: l.state });
      }
    }

    // icon smoothing
    if (info.sm) {
      const [key, sbase, mode] = info.sm;
      const m = (dx, dy) => smoothMatch(info.sm, e.grid, tx + dx, ty + dy);
      if (mode === 'Corners') {
        const n = m(0, 1), ne = m(1, 1), ea = m(1, 0), se = m(1, -1), s = m(0, -1), sw = m(-1, -1), w = m(-1, 0), nw = m(-1, 1);
        let cNE = 0, cNW = 0, cSW = 0, cSE = 0;
        if (n) { cNE |= 1; cNW |= 4; }
        if (ne) cNE |= 2;
        if (ea) { cNE |= 4; cSE |= 1; }
        if (se) cSE |= 2;
        if (s) { cSE |= 4; cSW |= 1; }
        if (sw) cSW |= 2;
        if (w) { cSW |= 4; cNW |= 1; }
        if (nw) cNW |= 2;
        const col = layers[0] ? layers[0].color : null;
        // SE uses the south frame, NE east (counter-clockwise), NW north (flip), SW west (clockwise)
        const corner = (v, dir) => ({ rsi: base, state: sbase + v, fixedDir: dir, color: col, smooth: true });
        layers.push(corner(cSE, 0), corner(cNE, 2), corner(cNW, 1), corner(cSW, 3));
      } else if (mode === 'CardinalFlags' || mode === 'Linear') {
        let f = 0;
        if (m(0, 1)) f |= 1;
        if (m(0, -1)) f |= 2;
        if (m(1, 0)) f |= 4;
        if (m(-1, 0)) f |= 8;
        if (!layers.length) layers.push({ rsi: base });
        layers[0] = { ...layers[0], state: sbase + f, tex: null, hidden: false, smooth: true };
      } else if (mode === 'Diagonal') {
        const c = Math.cos(rot), s = Math.sin(rot);
        const ok = [[1, 0], [1, -1], [0, -1]].every(([dx, dy]) =>
          m(Math.round(dx * c - dy * s), Math.round(dx * s + dy * c)));
        if (!layers.length) layers.push({ rsi: base });
        layers[0] = { ...layers[0], state: sbase + (ok ? 1 : 0), tex: null, hidden: false, smooth: true };
      }
    }

    // cables connect to the same kind of cable on neighbouring tiles
    if (info.cab) {
      const [pre, extra] = info.cab;
      const has = (dx, dy) => { const s = cableAt.get(tkey(e.grid, tx + dx, ty + dy)); return !!(s && s.has(pre)); };
      let f = 0;
      if (has(0, 1)) f |= 1;
      if (has(0, -1)) f |= 2;
      if (has(1, 0)) f |= 4;
      if (has(-1, 0)) f |= 8;
      if (layers[0]) layers[0] = { ...layers[0], state: pre + f, hidden: false };
      if (extra && layers[1]) layers[1] = { ...layers[1], state: extra + f, hidden: false };
    }

    for (const l of layers) {
      if (l.tex) need({ tex: l.tex });
      else if (l.rsi && l.state != null) need({ rsi: l.rsi, state: l.state });
    }
    if (info.sub) {
      // layers listed in SubFloorHide.visibleLayers stay visible over a floor (the vent grille, not its pipe)
      for (const l of layers) l.keepOnFloor = !!(info.sfv && l.map && l.map.some(m => info.sfv.includes(m)));
      it.hasFloorPart = layers.some(l => l.keepOnFloor);
      it.onCatwalk = catwalkAt.has(tkey(e.grid, tx, ty));
    }
    it.layers = layers;
    items.push(it);
  }

  // ---- decals (drawn just above the floor)
  for (const d of model.decals) {
    const info = db.decal[d.id];
    const it = { kind: 'decal', grid: d.grid, x: d.x + 0.5, y: d.y + 0.5, rot: d.angle, proto: d.id,
      name: 'decal ' + d.id, depth: -1000 + d.z, decalIndex: d.i, layers: [] };
    if (!info) { it.layers.push({ dev: true, color: d.color }); it.unknown = true; }
    else {
      const l = { rsi: info.s || null, state: info.st != null ? info.st : null, tex: info.t || null,
        color: d.color && d.color.toUpperCase() !== '#FFFFFFFF' ? d.color : null };
      it.layers.push(l);
      if (l.tex) need({ tex: l.tex }); else if (l.rsi && l.state != null) need({ rsi: l.rsi, state: l.state });
    }
    items.push(it);
  }

  // game order: draw depth, then north-to-south, then entity id
  items.sort((a, b) => a.depth - b.depth || b.y - a.y || (a.uid || 0) - (b.uid || 0));
  items.forEach((it, i) => { it.order = i; });
  return { items, tiles, subfloor, needs, unknownProtos };
}

// direction frame for an angle (radians, CCW, 0 = facing south)
export function dirFor(rot, dirs) {
  const a = ((rot % TAU) + TAU) % TAU;
  if (dirs >= 8) return DIR8[Math.round(a / (Math.PI / 4)) % 8];
  if (dirs >= 4) return DIR4[Math.round(a / (Math.PI / 2)) % 4];
  return 0;
}

// ------------------------------------------------------------------ renderer
export class SceneRenderer {
  constructor(store) {
    this.store = store;
    this.tintCache = new Map();
    this.opts = { ...DEFAULT_OPTS };
  }

  setScene(model, scene) {
    this.model = model;
    this.scene = scene;
    this.grids = new Map();
    for (const g of model.grids) this.grids.set(g.uid, { uid: g.uid, name: g.name, xf: g.xf });
    // free-floating entities get an identity "grid"
    this.grids.set(0, { uid: 0, name: 'map', xf: { x: 0, y: 0, r: 0 } });
    for (const gr of this.grids.values()) { gr.chunks = new Map(); gr.minX = Infinity; gr.minY = Infinity; gr.maxX = -Infinity; gr.maxY = -Infinity; }
    const grow = (gr, x0, y0, x1, y1) => {
      gr.minX = Math.min(gr.minX, x0); gr.minY = Math.min(gr.minY, y0);
      gr.maxX = Math.max(gr.maxX, x1); gr.maxY = Math.max(gr.maxY, y1);
    };
    const chunkOf = (gr, cx, cy) => {
      const k = cx + ',' + cy;
      let c = gr.chunks.get(k);
      if (!c) { c = { cx, cy, tiles: [], items: [], canvas: null, used: 0 }; gr.chunks.set(k, c); }
      return c;
    };
    for (const [uid, list] of scene.tiles) {
      const gr = this.grids.get(uid);
      for (const t of list) {
        chunkOf(gr, Math.floor(t.x / CHUNK), Math.floor(t.y / CHUNK)).tiles.push(t);
        grow(gr, t.x, t.y, t.x + 1, t.y + 1);
      }
    }
    this.byUid = new Map();
    for (const it of scene.items) {
      const gr = this.grids.get(it.grid) || this.grids.get(0);
      const rad = it.rad || 0.75;
      const x0 = Math.floor((it.x - rad) / CHUNK), x1 = Math.floor((it.x + rad) / CHUNK);
      const y0 = Math.floor((it.y - rad) / CHUNK), y1 = Math.floor((it.y + rad) / CHUNK);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) chunkOf(gr, cx, cy).items.push(it);
      grow(gr, it.x - rad, it.y - rad, it.x + rad, it.y + rad);
      if (it.uid != null) this.byUid.set(it.uid, it);
    }
    for (const [uid, gr] of this.grids) if (!gr.chunks.size) this.grids.delete(uid);
    this.makeOverviews();
  }

  // bounds of a sprite in tiles, computed once sprites are resolved
  computeRadius(it) {
    let r = 0.5;
    for (const l of it.layers) {
      const res = l.res;
      if (!res) continue;
      const s = (l.scale ? Math.max(l.scale[0], l.scale[1]) : 1) * (it.scale ? Math.max(it.scale[0], it.scale[1]) : 1);
      const w = (res.tex ? res.w : res.w) / PX, h = res.h / PX;
      const off = (l.offset ? Math.hypot(l.offset[0], l.offset[1]) : 0) + (it.offset ? Math.hypot(it.offset[0], it.offset[1]) : 0);
      r = Math.max(r, Math.hypot(w, h) / 2 * s + off);
    }
    it.rad = Math.min(r, 8);
  }

  makeOverviews() {
    for (const gr of this.grids.values()) {
      const w = gr.maxX - gr.minX, h = gr.maxY - gr.minY;
      if (!(w > 0 && h > 0)) { gr.ov = null; continue; }
      const op = Math.max(1, Math.min(8, Math.floor(4096 / Math.max(w, h))));
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * op); c.height = Math.ceil(h * op);
      gr.ov = { canvas: c, ctx: c.getContext('2d'), op, x0: gr.minX, y1: gr.maxY, done: new Set() };
      gr.ov.ctx.imageSmoothingEnabled = true;
    }
  }

  invalidate() {
    for (const gr of this.grids.values()) {
      for (const c of gr.chunks.values()) c.canvas = null;
      if (gr.ov) { gr.ov.ctx.clearRect(0, 0, gr.ov.canvas.width, gr.ov.canvas.height); gr.ov.done.clear(); }
    }
  }

  // is this item's spot under a floor (as the game sees it)?
  covered(it) {
    if (!it.sub || this.opts.pipeMode !== 'game' || !this.opts.tiles) return false;
    const sf = this.scene.subfloor.get(it.grid + ':' + it.tx + ',' + it.ty);
    return sf === false;
  }

  visible(it) {
    const o = this.opts;
    if (this.only && !this.only.test(it)) return false;
    if (it.kind === 'decal') return o.decals;
    if (it.marker) return o.markers;
    if (!o[it.cat || 'other']) return false;
    if (it.hiddenSprite && !o.allLayers) return false;
    if (this.covered(it) && !it.hasFloorPart) return false;
    return true;
  }

  layerVisible(l, it) {
    if (l.dev) return true;
    if (!l.res) return false;
    if (it && it.sub && !l.keepOnFloor && this.opts.pipeMode === 'game') {
      if (this.covered(it)) return false;
      // on a catwalk only the device shows; its pipe stub would poke out above the grating
      if (it.onCatwalk && it.hasFloorPart && it.depth > -12) return false;
    }
    if (this.opts.allLayers) return true;
    return !l.hidden && !l.runtimeHidden;
  }

  tileVisible(gridUid, t) {
    return !this.only || this.only.tile(gridUid, t);
  }

  tinted(res, rect, color) {
    const k = color;
    let m = this.tintCache.get(res.img);
    if (!m) { m = new Map(); this.tintCache.set(res.img, m); }
    const kk = k + '|' + rect.sx + ',' + rect.sy;
    if (m.has(kk)) return m.get(kk);
    const c = document.createElement('canvas');
    c.width = rect.sw; c.height = rect.sh;
    const g = c.getContext('2d');
    g.drawImage(res.img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = cssColor(color);
    g.fillRect(0, 0, rect.sw, rect.sh);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(res.img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
    const a = colorAlpha(color);
    let out = c;
    if (a < 1) {
      const c2 = document.createElement('canvas');
      c2.width = rect.sw; c2.height = rect.sh;
      const g2 = c2.getContext('2d');
      g2.globalAlpha = a; g2.drawImage(c, 0, 0);
      out = c2;
    }
    m.set(kk, out);
    return out;
  }

  // where a layer is drawn: centre (grid-local tiles), rotation, frame rect, scale
  placement(it, l) {
    const res = l.res;
    let dir = 0, rot = 0;
    if (l.dev || !res) {
      rot = 0;
    } else if (l.fixedDir != null) {
      dir = l.fixedDir;
    } else if (res.dirs >= 4) {
      dir = dirFor(it.rot, res.dirs);
      rot = 0;
    } else if (!it.noRot) {
      rot = it.rot;
    }
    rot += l.lrot || 0;
    let ox = 0, oy = 0;
    if (it.offset) { ox += it.offset[0]; oy += it.offset[1]; }
    if (l.offset) { ox += l.offset[0]; oy += l.offset[1]; }
    let cx = it.x, cy = it.y;
    if (ox || oy) {
      const rr = it.noRot ? 0 : it.rot;
      const c = Math.cos(rr), s = Math.sin(rr);
      cx += ox * c - oy * s; cy += ox * s + oy * c;
    }
    const r = res || this.store.dev();
    let rect = this.store.frameRect(r, dir);
    if (it.kind === 'tile') rect = it.rect;
    let sx = 1, sy = 1;
    if (it.scale) { sx *= it.scale[0]; sy *= it.scale[1]; }
    if (l.scale) { sx *= l.scale[0]; sy *= l.scale[1]; }
    return { cx, cy, rot, rect, sx, sy, res: r };
  }

  drawItem(g, it, toPx, P) {
    for (const l of it.layers) {
      if (!this.layerVisible(l, it)) continue;
      const p = this.placement(it, l);
      const [px, py] = toPx(p.cx, p.cy);
      const w = p.rect.sw * P / PX * p.sx, h = p.rect.sh * P / PX * p.sy;
      g.save();
      g.translate(px, py);
      if (p.rot) g.rotate(-p.rot);
      if (l.color && !p.res.dev) {
        g.drawImage(this.tinted(p.res, p.rect, l.color), -w / 2, -h / 2, w, h);
      } else {
        g.drawImage(p.res.img, p.rect.sx, p.rect.sy, p.rect.sw, p.rect.sh, -w / 2, -h / 2, w, h);
      }
      g.restore();
    }
  }

  drawTile(g, t, x0, y1, P) {
    const res = t.res;
    if (!res) return;
    let sx = 0;
    if (!res.dev && t.td && t.td.v > 1 && res.img.width >= PX * 2) sx = Math.min(t.v, Math.floor(res.img.width / PX) - 1) * PX;
    const sw = res.dev ? res.img.width : Math.min(PX, res.img.width), sh = res.dev ? res.img.height : Math.min(PX, res.img.height);
    const px = (t.x - x0) * P, py = (y1 - t.y - 1) * P;
    if (t.rm) {
      g.save();
      g.translate(px + P / 2, py + P / 2);
      g.rotate(-(t.rm & 3) * Math.PI / 2);
      if (t.rm >= 4) g.scale(-1, 1);
      g.drawImage(res.img, sx, 0, sw, sh, -P / 2, -P / 2, P, P);
      g.restore();
    } else {
      g.drawImage(res.img, sx, 0, sw, sh, px, py, P, P);
    }
  }

  renderChunk(gr, c) {
    const P = PX;
    if (!c.canvas) {
      c.canvas = document.createElement('canvas');
      c.canvas.width = CHUNK * P; c.canvas.height = CHUNK * P;
    }
    const g = c.canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.canvas.width, c.canvas.height);
    const x0 = c.cx * CHUNK, y1 = (c.cy + 1) * CHUNK;
    if (this.opts.tiles) for (const t of c.tiles) if (this.tileVisible(gr.uid, t)) this.drawTile(g, t, x0, y1, P);
    const toPx = (x, y) => [(x - x0) * P, (y1 - y) * P];
    if (this.opts.pipeMode === 'top') {
      // pipes and cables over everything else
      for (const it of c.items) if (!NET_CATS.has(it.cat) && this.visible(it)) this.drawItem(g, it, toPx, P);
      for (const it of c.items) if (NET_CATS.has(it.cat) && this.visible(it)) this.drawItem(g, it, toPx, P);
    } else {
      for (const it of c.items) if (this.visible(it)) this.drawItem(g, it, toPx, P);
    }
    c.used = performance.now();
    // copy into the overview
    const ov = gr.ov;
    if (ov && !ov.done.has(c)) {
      ov.done.add(c);
      const dx = (x0 - ov.x0) * ov.op, dy = (ov.y1 - y1) * ov.op;
      ov.ctx.drawImage(c.canvas, dx, dy, CHUNK * ov.op, CHUNK * ov.op);
    }
  }

  // keep memory in check
  evict(max = 220) {
    const all = [];
    for (const gr of this.grids.values()) for (const c of gr.chunks.values()) if (c.canvas) all.push(c);
    if (all.length <= max) return;
    all.sort((a, b) => a.used - b.used);
    for (let i = 0; i < all.length - max; i++) all[i].canvas = null;
  }

  // everything under a grid-local point, top-most first
  pick(gridUid, lx, ly) {
    const gr = this.grids.get(gridUid);
    if (!gr) return [];
    const c = gr.chunks.get(Math.floor(lx / CHUNK) + ',' + Math.floor(ly / CHUNK));
    if (!c) return [];
    const hits = [];
    for (const it of c.items) {
      if (!this.visible(it)) continue;
      if (Math.abs(it.x - lx) > (it.rad || 0.75) || Math.abs(it.y - ly) > (it.rad || 0.75)) continue;
      let hitLayer = null, solid = false;
      for (const l of it.layers) {
        if (!this.layerVisible(l, it)) continue;
        const p = this.placement(it, l);
        const dx = lx - p.cx, dy = ly - p.cy;
        const cs = Math.cos(-p.rot), sn = Math.sin(-p.rot);
        const rx = dx * cs - dy * sn, ry = dx * sn + dy * cs;
        const u = rx * PX / p.sx + p.rect.sw / 2, v = -ry * PX / p.sy + p.rect.sh / 2;
        if (u < 0 || v < 0 || u >= p.rect.sw || v >= p.rect.sh) continue;
        hitLayer = hitLayer || l;
        if (this.store.alphaAt(p.res.img, p.rect.sx + u, p.rect.sy + v) > 8) { solid = true; hitLayer = l; }
      }
      if (hitLayer) hits.push({ it, solid, layer: hitLayer });
    }
    hits.sort((a, b) => (b.solid - a.solid) || (b.it.order - a.it.order));
    const tx = Math.floor(lx), ty = Math.floor(ly);
    const tile = c.tiles.find(t => t.x === tx && t.y === ty) || null;
    return { hits, tile };
  }
}

export function cssColor(c) {
  if (!c) return '#fff';
  const s = String(c).trim();
  const m = /^#([0-9a-f]{8})$/i.exec(s);
  if (m) {
    const h = m[1];
    return '#' + h.slice(0, 6);
  }
  return s;
}
function colorAlpha(c) {
  const m = /^#([0-9a-f]{8})$/i.exec(String(c || '').trim());
  return m ? parseInt(m[1].slice(6, 8), 16) / 255 : 1;
}
