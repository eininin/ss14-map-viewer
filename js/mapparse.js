// Map .yml -> compact model. Runs inside a Web Worker (see parse.worker.js).
/* global jsyaml */

function makeSchema(yaml) {
  // SS14 files use custom tags like `!type:SoundPathSpecifier`; accept any tag.
  const any = ['scalar', 'sequence', 'mapping'].map(kind =>
    new yaml.Type('!', { kind, multi: true, construct: d => d }));
  return yaml.DEFAULT_SCHEMA.extend(any);
}

function vec(v) {
  if (v == null) return [0, 0];
  if (Array.isArray(v)) return [+v[0] || 0, +v[1] || 0];
  const p = String(v).split(',');
  return [parseFloat(p[0]) || 0, parseFloat(p[1]) || 0];
}

function angle(v) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s.endsWith('rad')) return parseFloat(s) || 0;
  if (s.endsWith('deg')) return (parseFloat(s) || 0) * Math.PI / 180;
  return (parseFloat(s) || 0) * Math.PI / 180;
}

function b64(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseMap(text, yaml) {
  const doc = yaml.load(text, { schema: makeSchema(yaml) });
  if (!doc || typeof doc !== 'object') throw new Error('Not a map file');
  const tilemap = {};
  for (const [k, v] of Object.entries(doc.tilemap || {})) tilemap[+k] = String(v);

  // flatten entities (format 6/7 groups them by proto; older files are flat)
  const raw = [];
  for (const g of doc.entities || []) {
    if (g && Array.isArray(g.entities)) {
      for (const e of g.entities) raw.push({ uid: e.uid, proto: g.proto || '', comps: e.components || [] });
    } else if (g && g.uid != null) {
      raw.push({ uid: g.uid, proto: g.type || '', comps: g.components || [] });
    }
  }

  const byUid = new Map();
  for (const r of raw) {
    const c = {};
    for (const comp of r.comps) if (comp && comp.type) c[comp.type] = comp;
    const xf = c.Transform || {};
    byUid.set(r.uid, {
      uid: r.uid, proto: String(r.proto), c,
      parent: xf.parent != null ? xf.parent : null,
      pos: vec(xf.pos), rot: angle(xf.rot),
    });
  }

  const grids = [];
  const gridSet = new Set();
  const mapSet = new Set();
  for (const e of byUid.values()) {
    if (e.c.Map) mapSet.add(e.uid);
    if (e.c.MapGrid) gridSet.add(e.uid);
  }

  // world transform of a grid (grid may sit on a map, or rarely on another grid)
  function worldXf(uid, depth = 0) {
    const e = byUid.get(uid);
    if (!e || depth > 8 || mapSet.has(uid)) return { x: 0, y: 0, r: 0 };
    const p = e.parent != null ? worldXf(e.parent, depth + 1) : { x: 0, y: 0, r: 0 };
    const c = Math.cos(p.r), s = Math.sin(p.r);
    return { x: p.x + e.pos[0] * c - e.pos[1] * s, y: p.y + e.pos[0] * s + e.pos[1] * c, r: p.r + e.rot };
  }

  const decals = [];
  for (const uid of gridSet) {
    const e = byUid.get(uid);
    const chunks = [];
    const mg = e.c.MapGrid;
    const csize = mg.chunkSize || 16;
    for (const [key, ch] of Object.entries(mg.chunks || {})) {
      const ind = vec(ch.ind || key);
      const bytes = b64(ch.tiles || '');
      const n = csize * csize;
      const bpt = Math.round(bytes.length / n) || 6;
      const dv = new DataView(bytes.buffer);
      const ids = new Int32Array(n), vari = new Uint8Array(n), rm = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * bpt;
        if (o + bpt > bytes.length) break;
        if (bpt === 4) { ids[i] = dv.getUint16(o, true); vari[i] = bytes[o + 3]; }
        else { ids[i] = dv.getInt32(o, true); vari[i] = bytes[o + 5]; if (bpt >= 7) rm[i] = bytes[o + 6]; }
      }
      chunks.push({ cx: ind[0], cy: ind[1], size: csize, ids, vari, rm });
    }
    const name = (e.c.MetaData && e.c.MetaData.name) || ('grid ' + uid);
    grids.push({ uid, name, xf: worldXf(uid), chunks });

    const dg = e.c.DecalGrid;
    const nodes = dg && dg.chunkCollection && dg.chunkCollection.nodes;
    if (Array.isArray(nodes)) {
      for (const nd of nodes) {
        const node = nd.node || {};
        for (const [idx, p] of Object.entries(nd.decals || {})) {
          const v = vec(p);
          decals.push({ grid: uid, i: +idx, id: String(node.id), color: node.color || null,
            angle: angle(node.angle), z: +node.zIndex || 0, x: v[0], y: v[1] });
        }
      }
    }
  }

  const ents = [];
  for (const e of byUid.values()) {
    if (gridSet.has(e.uid) || mapSet.has(e.uid) || !e.proto) continue;
    let grid;
    if (gridSet.has(e.parent)) grid = e.parent;
    else if (mapSet.has(e.parent)) grid = 0;           // free-floating on the map
    else continue;                                      // inside a container / attached
    const o = { uid: e.uid, proto: e.proto, grid, x: e.pos[0], y: e.pos[1], rot: e.rot };
    if (e.c.AtmosPipeColor && e.c.AtmosPipeColor.color) o.pipe = String(e.c.AtmosPipeColor.color);
    if (e.c.MetaData && e.c.MetaData.name) o.name = String(e.c.MetaData.name);
    if (e.c.Door && e.c.Door.state) o.door = /^open/i.test(String(e.c.Door.state)) ? 'open' : 'closed';
    ents.push(o);
  }
  decals.sort((a, b) => a.z - b.z || a.i - b.i);

  let name = (doc.meta && doc.meta.name) || '';
  if (!name) for (const g of grids) { name = g.name; break; }
  return {
    meta: doc.meta || {}, name, tilemap, grids, ents, decals,
    entityCount: byUid.size,
  };
}

if (typeof self !== 'undefined' && typeof module === 'undefined') self.parseMap = parseMap;
if (typeof module !== 'undefined') module.exports = { parseMap };
