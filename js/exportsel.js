// Cut a selection out of a map .yml and write it as a new, loadable map file.
// Keeps: the map + the selected grid entity, every entity on a selected tile (and whatever is
// inside it), floor tiles, decals and tile atmospheres in the selection. Custom YAML tags
// (`!type:...`) survive the round trip.

let yaml = null;
async function lib() {
  if (yaml) return yaml;
  if (!window.jsyaml) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'js/vendor/js-yaml.min.js';
      s.onload = res; s.onerror = () => rej(new Error('could not load the YAML library'));
      document.head.appendChild(s);
    });
  }
  yaml = window.jsyaml;
  return yaml;
}

class Tagged { constructor(tag, data) { this.tag = tag; this.data = data; } }
function schema(y) {
  const kinds = ['scalar', 'sequence', 'mapping'];
  const types = kinds.map(kind => new y.Type('!', {
    kind, multi: true,
    construct: (data, tag) => new Tagged(tag, data),
    instanceOf: Tagged,
    predicate: (o) => o instanceof Tagged && (kind === 'mapping' ? o.data && typeof o.data === 'object' && !Array.isArray(o.data)
      : kind === 'sequence' ? Array.isArray(o.data) : (o.data == null || typeof o.data !== 'object')),
    represent: (o) => o.data,
    representName: (o) => o.tag,
  }));
  return y.DEFAULT_SCHEMA.extend(types);
}
const plain = (v) => v instanceof Tagged ? v.data : v;

function vec(v) {
  v = plain(v);
  if (v == null) return [0, 0];
  if (Array.isArray(v)) return [+v[0] || 0, +v[1] || 0];
  const p = String(v).split(',');
  return [parseFloat(p[0]) || 0, parseFloat(p[1]) || 0];
}
function b64dec(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64enc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * opts: {
 *   text: original map yml, gridUid: grid the selection is on, tiles: Set("x,y") on that grid,
 *   keepEntity(uid) -> bool  (layer filter for entities standing on the grid),
 *   keepTiles: bool, keepDecals: bool
 * }
 * returns { text, entities, tiles, decals }
 */
export async function exportSelection(opts) {
  const y = await lib();
  const sch = schema(y);
  const doc = y.load(opts.text, { schema: sch });
  const area = opts.tiles;
  const inArea = (x, yy) => area.has(Math.floor(x) + ',' + Math.floor(yy));

  // ---- index entities
  const groups = doc.entities || [];
  const all = new Map();      // uid -> {comps, parent, pos}
  for (const g of groups) for (const e of (g.entities || [])) {
    const c = {};
    for (const comp of e.components || []) if (comp && comp.type) c[comp.type] = comp;
    const xf = c.Transform || {};
    all.set(e.uid, { e, c, parent: xf.parent != null ? plain(xf.parent) : null, pos: vec(xf.pos) });
  }
  const isMap = (u) => all.has(u) && all.get(u).c.Map;
  const grid = opts.gridUid;

  // ---- choose entities
  const keep = new Set();
  for (const [uid, x] of all) if (x.c.Map) keep.add(uid);
  keep.add(grid);
  for (const [uid, x] of all) {
    if (x.parent !== grid || uid === grid) continue;
    if (!inArea(x.pos[0], x.pos[1])) continue;
    if (opts.keepEntity && !opts.keepEntity(uid)) continue;
    keep.add(uid);
  }
  // things inside kept entities (locker contents, items in hands, …)
  let grew = true;
  while (grew) {
    grew = false;
    for (const [uid, x] of all) {
      if (keep.has(uid) || x.parent == null) continue;
      if (keep.has(x.parent) && x.parent !== grid && !isMap(x.parent)) { keep.add(uid); grew = true; }
    }
  }
  const out = [];
  for (const g of groups) {
    const ents = (g.entities || []).filter(e => keep.has(e.uid));
    if (ents.length) out.push({ ...g, entities: ents });
  }
  doc.entities = out;

  // ---- trim the grid entity's per-tile data
  const gx = all.get(grid);
  let tileCount = 0, decalCount = 0;
  if (gx) {
    // floor tiles: everything outside the selection becomes space
    const mg = gx.c.MapGrid;
    if (mg && mg.chunks) {
      let spaceId = 0;
      for (const [k, v] of Object.entries(doc.tilemap || {})) if (plain(v) === 'Space') spaceId = +k;
      const cs = mg.chunkSize || 16;
      const chunks = {};
      for (const [key, ch] of Object.entries(mg.chunks)) {
        const ind = vec(ch.ind || key);
        const bytes = b64dec(ch.tiles || '');
        const n = cs * cs;
        const bpt = Math.round(bytes.length / n) || 6;
        const dv = new DataView(bytes.buffer);
        let any = false;
        for (let i = 0; i < n; i++) {
          const o = i * bpt;
          if (o + bpt > bytes.length) break;
          const x = ind[0] * cs + (i % cs), yy = ind[1] * cs + Math.floor(i / cs);
          const id = bpt === 4 ? dv.getUint16(o, true) : dv.getInt32(o, true);
          const keepTile = opts.keepTiles && area.has(x + ',' + yy);
          if (!keepTile) {
            bytes.fill(0, o, o + bpt);
            if (bpt === 4) dv.setUint16(o, spaceId, true); else dv.setInt32(o, spaceId, true);
          } else if (id !== spaceId) { any = true; tileCount++; }
        }
        if (any) chunks[key] = { ...ch, tiles: b64enc(bytes) };
      }
      mg.chunks = chunks;
    }
    // decals: keep those whose tile is selected
    const dg = gx.c.DecalGrid;
    const nodes = dg && dg.chunkCollection && dg.chunkCollection.nodes;
    if (Array.isArray(nodes)) {
      const kept = [];
      for (const nd of nodes) {
        const decals = {};
        if (opts.keepDecals) for (const [idx, p] of Object.entries(nd.decals || {})) {
          const v = vec(p);
          if (inArea(v[0] + 0.5, v[1] + 0.5)) { decals[idx] = p; decalCount++; }
        }
        if (Object.keys(decals).length) kept.push({ ...nd, decals });
      }
      dg.chunkCollection.nodes = kept;
    }
    // tile atmospheres: chunks of chunkSize x chunkSize tiles, one bit per tile per unique mix
    const ga = gx.c.GridAtmosphere;
    const data = ga && ga.data;
    if (data && data.tiles) {
      const cs = +plain(data.chunkSize) || 4;
      const tiles = {};
      for (const [key, mixes] of Object.entries(data.tiles)) {
        const o = vec(key);
        const nm = {};
        for (const [mix, flags] of Object.entries(mixes || {})) {
          let f = Number(plain(flags)) >>> 0, nf = 0;
          for (let x = 0; x < cs; x++) for (let yy = 0; yy < cs; yy++) {
            const bit = 1 << (x + yy * cs);
            if ((f & bit) && area.has((o[0] * cs + x) + ',' + (o[1] * cs + yy))) nf |= bit;
          }
          if (nf) nm[mix] = nf >>> 0;
        }
        if (Object.keys(nm).length) tiles[key] = nm;
      }
      data.tiles = tiles;
    }
  }

  // ---- top-level lists and meta
  const filt = (a) => Array.isArray(a) ? a.filter(u => keep.has(plain(u))) : a;
  if (doc.maps) doc.maps = filt(doc.maps);
  if (doc.grids) doc.grids = filt(doc.grids);
  if (doc.orphans) doc.orphans = filt(doc.orphans);
  if (doc.nullspace) doc.nullspace = filt(doc.nullspace);
  if (doc.meta) {
    doc.meta.entityCount = keep.size;
    doc.meta.time = new Date().toLocaleString('en-GB').replace(',', '');
  }
  const text = y.dump(doc, { schema: sch, lineWidth: -1, noRefs: true, noCompatMode: true });
  return { text, entities: keep.size, tiles: tileCount, decals: decalCount };
}
