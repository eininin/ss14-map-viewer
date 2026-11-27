// Room visibility for the Blender importer / Unity: which rooms can be seen from which.
// Worked out flat on a half-tile grid (one cell per tile quarter). Cells of a tile with an occluder that
// isn't a door block sight; doors count as open, windows and grilles don't block. Every tile of a room
// that doesn't block sight is sampled with an N×N grid of eye points, inset slightly from the tile edges.
// From each eye point, a permissive cast: a cell counts as seen if any ray from the point reaches any part
// of it. Rays that leave the grid see Outside (room id 0), as do seen cells with no room.
// Runs in a worker (roomvis-worker.js) or directly.

// grid: { w, h, block: Uint8Array(w*h), owner: Int32Array(w*h) }  (cell = half a tile; owner 0 = outside)
// eyes: Float64Array of x, y pairs in cell units
// returns the set of room ids seen (0 = outside)
export function seenFrom(grid, eyes, seen = new Set(), onEye) {
  const { w, h, block, owner } = grid;
  for (let e = 0; e < eyes.length; e += 2) {
    const px = eyes[e], py = eyes[e + 1];
    const own = owner[Math.floor(py) * w + Math.floor(px)];
    if (own) seen.add(own);
    const local = onEye ? new Set() : seen;
    for (let q = 0; q < 4; q++) cone(grid, px, py, q, local);
    if (onEye) { for (const v of local) seen.add(v); onEye(e / 2, local); }
  }
  return seen;
}

// one 90° cone (q: 0 north, 1 east, 2 south, 3 west), rows outward from the eye
function cone(grid, px, py, q, seen) {
  const { w, h, block, owner } = grid;
  // turn the cone to "north": v outward from the eye, u across. North: x = u, y = v; east: x = v, y = u;
  // south: x = u, y = h - v; west: x = w - v, y = u (continuous; cells mirror accordingly)
  const ns = q === 0 || q === 2;
  const U = ns ? px : py;
  const V = q === 0 ? py : q === 1 ? px : q === 2 ? h - py : w - px;
  const vMax = ns ? h : w, uMax = ns ? w : h;
  const cell = (u, v) => {
    const x = q === 0 || q === 2 ? u : q === 1 ? v : w - 1 - v;
    const y = q === 1 || q === 3 ? u : q === 0 ? v : h - 1 - v;
    return y * w + x;
  };
  let open = [-1, 1];                         // open slope intervals [a0, b0, a1, b1, …]
  const v0 = Math.floor(V);
  for (let j = 1; open.length; j++) {
    const v = v0 + j;
    if (v >= vMax) { seen.add(0); return; }   // still open past the grid: sight goes out into space
    const near = v - V, far = near + 1;
    let blocks = null, lastU = -Infinity;
    // only the cells under the open slopes
    for (let i = 0; i < open.length; i += 2) {
      const sa = open[i], sb = open[i + 1];
      let uLo = Math.floor(U + Math.min(sa * near, sa * far)), uHi = Math.floor(U + Math.max(sb * near, sb * far));
      if (uLo <= lastU) uLo = lastU + 1;
      for (let u = uLo; u <= uHi; u++) {
        const a = u - U, b = a + 1;
        let s0 = Math.min(a / near, a / far), s1 = Math.max(b / near, b / far);
        if (s1 <= -1 || s0 >= 1) continue;
        if (s0 < -1) s0 = -1;
        if (s1 > 1) s1 = 1;
        let vis = false;
        for (let k = i; k < open.length; k += 2) { if (open[k] >= s1 - 1e-9) break; if (open[k + 1] > s0 + 1e-9) { vis = true; break; } }
        if (!vis) continue;
        if (u < 0 || u >= uMax) { seen.add(0); continue; }
        const c = cell(u, v);
        seen.add(owner[c]);
        if (block[c]) (blocks || (blocks = [])).push(s0, s1);
      }
      if (uHi > lastU) lastU = uHi;
    }
    if (blocks) open = subtract(open, blocks);
  }
}

function subtract(open, blocks) {
  let cur = open;
  for (let i = 0; i < blocks.length; i += 2) {
    const a = blocks[i], b = blocks[i + 1], next = [];
    for (let k = 0; k < cur.length; k += 2) {
      const x = cur[k], y = cur[k + 1];
      if (b <= x || a >= y) { next.push(x, y); continue; }
      if (a > x + 1e-12) next.push(x, a);
      if (b < y - 1e-12) next.push(b, y);
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur;
}

// eye points of one tile, in cell units: n×n, from inset to 1 − inset across the tile
export function tileEyes(x, y, n, inset, out) {
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const fx = inset + (1 - 2 * inset) * (n === 1 ? 0.5 : i / (n - 1));
    const fy = inset + (1 - 2 * inset) * (n === 1 ? 0.5 : j / (n - 1));
    out.push((x + fx) * 2, (y + fy) * 2);
  }
  return out;
}
