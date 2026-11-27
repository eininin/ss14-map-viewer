// Cut a selection out of a map .yml and write it as a new, loadable map file.
// Keeps: the map + the selected grid entity, every entity on a selected tile (and whatever is
// inside it), floor tiles, decals and tile atmospheres in the selection. The file is parsed only to
// decide what to keep; the output is the original text with lines cut out, so everything kept stays
// exactly as the game wrote it (layout, quoting, custom `!type:` tags).

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
  // ---- work out the new per-tile data of the grid entity (from the parsed copy)
  const gx = all.get(grid);
  let tileCount = 0, decalCount = 0;
  const chunkTiles = new Map();         // chunk key -> new base64, or null to drop the chunk
  let atmosCs = 4;
  if (gx) {
    const mg = gx.c.MapGrid;
    if (mg && mg.chunks) {
      let spaceId = 0;
      for (const [k, v] of Object.entries(doc.tilemap || {})) if (plain(v) === 'Space') spaceId = +k;
      const cs = mg.chunkSize || 16;
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
        chunkTiles.set(String(key), any ? b64enc(bytes) : null);
      }
    }
    const ga = gx.c.GridAtmosphere;
    if (ga && ga.data && ga.data.chunkSize != null) atmosCs = +plain(ga.data.chunkSize) || 4;
  }

  // ---- cut the text: everything kept stays exactly as it was written; only removed entities and the
  // trimmed per-tile data of the grid entity change
  const nl = opts.text.includes('\r\n') ? '\r\n' : '\n';
  const L = opts.text.split(/\r?\n/);
  const drop = new Uint8Array(L.length), repl = new Map();
  const ind = (i) => L[i].length - L[i].trimStart().length;
  const blank = (i) => { const t = L[i].trim(); return !t || t[0] === '#'; };
  const isItem = (i) => L[i].trimStart().startsWith('- ') || L[i].trim() === '-';
  // end of a list item starting at i: the next line at the same or a lower indent
  const itemEnd = (i, end) => { const n = ind(i); let j = i + 1; while (j < end && (blank(j) || ind(j) > n)) j++; return j; };
  // end of a key's block: lower indent, or the same indent that isn't one of its list items
  const keyEnd = (i, end) => { const n = ind(i); let j = i + 1; while (j < end && (blank(j) || ind(j) > n || (ind(j) === n && isItem(j)))) j++; return j; };
  const dropRange = (a, b) => { for (let i = a; i < b; i++) drop[i] = 1; };
  const findLine = (re, a, b, indent) => { for (let i = a; i < b; i++) if (!blank(i) && (indent == null || ind(i) === indent) && re.test(L[i])) return i; return -1; };
  const unq = (t) => t.replace(/^['"]|['"]$/g, '');
  // the items (or keys) directly under the block at line k
  const childStarts = (k, end, wantItems) => {
    const out = []; let n = -1;
    for (let j = k + 1; j < end; j++) {
      if (blank(j)) continue;
      if (n < 0) n = ind(j);
      if (ind(j) < n) break;
      if (ind(j) === n && (!wantItems || isItem(j))) out.push(j);
    }
    return out;
  };
  const topKey = (name) => findLine(new RegExp('^' + name + ':'), 0, L.length, 0);

  // entities
  const ek = topKey('entities');
  if (ek >= 0) {
    const eEnd = keyEnd(ek, L.length);
    for (const g of childStarts(ek, eEnd, true)) {
      const gEnd = itemEnd(g, eEnd);
      const sub = findLine(/^\s*(- )?entities:\s*$/, g + 1, gEnd);
      if (sub < 0) continue;
      let kept = 0;
      for (const u of childStarts(sub, gEnd, true)) {
        const m = /uid:\s*(\d+)/.exec(L[u]);
        const uEnd = itemEnd(u, gEnd);
        if (m && keep.has(+m[1])) kept++; else dropRange(u, uEnd);
      }
      if (!kept) dropRange(g, gEnd);
    }
    // the grid entity's per-tile data
    if (gx) {
      let gu = -1;
      for (let i = ek; i < eEnd; i++) { const m = /^\s*- uid:\s*(\d+)\s*$/.exec(L[i]); if (m && +m[1] === grid) { gu = i; break; } }
      const guEnd = gu >= 0 ? itemEnd(gu, eEnd) : -1;
      const comp = (type) => { const c = findLine(new RegExp('^\\s*- type: ' + type + '\\s*$'), gu, guEnd); return c < 0 ? null : [c, itemEnd(c, guEnd)]; };
      // MapGrid chunks
      const mgc = gu >= 0 && comp('MapGrid');
      if (mgc) {
        const ch = findLine(/^\s*chunks:\s*$/, mgc[0], mgc[1]);
        if (ch >= 0) {
          const chEnd = keyEnd(ch, mgc[1]);
          for (const c of childStarts(ch, chEnd, false)) {
            const cEnd = itemEnd(c, chEnd);
            const key = unq(L[c].trim().replace(/:\s*$/, ''));
            if (!chunkTiles.has(key)) continue;
            const t = chunkTiles.get(key);
            if (t == null) { dropRange(c, cEnd); continue; }
            const tl = findLine(/^\s*tiles:/, c + 1, cEnd);
            if (tl < 0) continue;
            repl.set(tl, L[tl].slice(0, ind(tl)) + 'tiles: ' + t);
            let j = tl + 1; while (j < cEnd && !blank(j) && ind(j) > ind(tl)) { drop[j] = 1; j++; }
          }
        }
      }
      // decals: rows "index: x,y" under each node; a node with none left goes
      const dgc = gu >= 0 && comp('DecalGrid');
      if (dgc) {
        for (let n = dgc[0]; n < dgc[1]; n++) {
          if (!/^\s*- node:\s*$/.test(L[n])) continue;
          const nEnd = itemEnd(n, dgc[1]);
          const dk = findLine(/^\s*decals:\s*$/, n + 1, nEnd);
          let kept = 0;
          if (dk >= 0) {
            const dEnd = keyEnd(dk, nEnd);
            for (let r = dk + 1; r < dEnd; r++) {
              if (blank(r)) continue;
              const m = /^\s*['"]?\d+['"]?:\s*['"]?(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)/.exec(L[r]);
              if (m && opts.keepDecals && inArea(+m[1] + 0.5, +m[2] + 0.5)) { kept++; decalCount++; } else drop[r] = 1;
            }
          }
          if (!kept) dropRange(n, nEnd);
          n = nEnd - 1;
        }
      }
      // tile atmospheres: one bit per tile per mix, chunks of chunkSize × chunkSize tiles
      const gac = gu >= 0 && comp('GridAtmosphere');
      if (gac) {
        const dl = findLine(/^\s*data:\s*$/, gac[0], gac[1]);
        const tk = dl >= 0 ? findLine(/^\s*tiles:\s*$/, dl + 1, gac[1]) : -1;
        if (tk >= 0) {
          const tEnd = keyEnd(tk, gac[1]), cs = atmosCs;
          for (const c of childStarts(tk, tEnd, false)) {
            const cEnd = itemEnd(c, tEnd);
            const o = vec(unq(L[c].trim().replace(/:\s*$/, '')));
            let kept = 0;
            for (let r = c + 1; r < cEnd; r++) {
              if (blank(r)) continue;
              const m = /^(\s*)(['"]?\d+['"]?):\s*(\d+)\s*$/.exec(L[r]);
              if (!m) { kept++; continue; }
              const f = (+m[3]) >>> 0;
              let nf = 0;
              for (let x = 0; x < cs; x++) for (let yy = 0; yy < cs; yy++) {
                const bit = 1 << (x + yy * cs);
                if ((f & bit) && area.has((o[0] * cs + x) + ',' + (o[1] * cs + yy))) nf |= bit;
              }
              nf >>>= 0;
              if (!nf) { drop[r] = 1; continue; }
              kept++;
              if (nf !== f) repl.set(r, m[1] + m[2] + ': ' + nf);
            }
            if (!kept) dropRange(c, cEnd);
          }
        }
      }
    }
  }
  // top-level uid lists
  for (const name of ['maps', 'grids', 'orphans', 'nullspace']) {
    const k = topKey(name);
    if (k < 0 || /\[\s*\]/.test(L[k])) continue;
    const kEnd = keyEnd(k, L.length);
    let kept = 0;
    for (let i = k + 1; i < kEnd; i++) {
      if (blank(i)) continue;
      const m = /^\s*-\s*['"]?(\d+)['"]?\s*$/.exec(L[i]);
      if (m && !keep.has(+m[1])) drop[i] = 1; else kept++;
    }
    if (!kept) repl.set(k, name + ': []');
  }
  // meta.entityCount
  const mk = topKey('meta');
  if (mk >= 0) {
    const ec = findLine(/^\s*entityCount:/, mk + 1, keyEnd(mk, L.length));
    if (ec >= 0) repl.set(ec, L[ec].slice(0, ind(ec)) + 'entityCount: ' + keep.size);
  }
  const outLines = [];
  for (let i = 0; i < L.length; i++) if (!drop[i]) outLines.push(repl.has(i) ? repl.get(i) : L[i]);
  const text = outLines.join(nl);
  return { text, entities: keep.size, tiles: tileCount, decals: decalCount };
}
