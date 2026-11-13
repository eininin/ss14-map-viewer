// Field of view from an area: every tile that can be seen from at least one tile of the area.
// Sight is blocked by tiles holding an occluder (walls, closed solid doors, bookshelves…), the
// same component the game uses for its view. Uses symmetric shadowcasting from each tile centre
// (walls are full squares; diagonal gaps between walls do not let sight through).

const K = (x, y) => (x + 32768) * 65536 + (y + 32768);
const KX = (k) => Math.floor(k / 65536) - 32768;
const KY = (k) => (k % 65536) - 32768;

/**
 * @param {object} o
 * @param {Iterable<string>} o.source  "x,y" tiles the viewer can stand on
 * @param {Set<number>} o.opaque       K(x,y) of tiles that block sight
 * @param {Set<number>} o.floor        K(x,y) of tiles that exist (floor, lattice…)
 * @param {number[]} o.bounds          [minX, minY, maxX, maxY] of the grid (tiles)
 * @param {number} [o.range]           max distance in tiles (0 / empty = unlimited)
 * @returns {{see:Set<string>, walls:Set<string>, sources:number}}
 *   see: visible tiles outside the source that exist and do not block sight
 *   walls: visible sight-blocking tiles outside the source
 */
export function fieldOfView(o) {
  const { opaque, floor } = o;
  const [bx0, by0, bx1, by1] = o.bounds;
  const range = o.range > 0 ? o.range : 0;
  const src = new Set();
  for (const s of o.source) {
    const i = s.indexOf(',');
    const k = K(+s.slice(0, i), +s.slice(i + 1));
    if (!opaque.has(k)) src.add(k);
  }
  const seen = new Set();
  const r2 = range * range;
  for (const sk of src) {
    const ox = KX(sk), oy = KY(sk);
    // furthest depth worth scanning: to the far edge of the grid (or the range)
    let maxDepth = Math.max(ox - bx0, bx1 - ox, oy - by0, by1 - oy) + 1;
    if (range) maxDepth = Math.min(maxDepth, Math.ceil(range));
    for (let q = 0; q < 4; q++) castQuadrant(ox, oy, q, maxDepth, opaque, (x, y) => {
      if (range && (x - ox) * (x - ox) + (y - oy) * (y - oy) > r2) return;
      seen.add(K(x, y));
    });
  }
  const see = new Set(), walls = new Set();
  for (const k of seen) {
    if (src.has(k)) continue;
    const key = KX(k) + ',' + KY(k);
    if (opaque.has(k)) walls.add(key);
    else if (floor.has(k)) see.add(key);
  }
  return { see, walls, sources: src.size };
}

// one quadrant (north, east, south, west) of symmetric shadowcasting, without recursion
function castQuadrant(ox, oy, q, maxDepth, opaque, mark) {
  const tx = (d, c) => q === 0 ? ox + c : q === 1 ? ox + d : q === 2 ? ox + c : ox - d;
  const ty = (d, c) => q === 0 ? oy + d : q === 1 ? oy + c : q === 2 ? oy - d : oy + c;
  const wall = (d, c) => opaque.has(K(tx(d, c), ty(d, c)));
  const stack = [[1, -1, 1]];               // depth, start slope, end slope
  while (stack.length) {
    let [depth, start, end] = stack.pop();
    if (depth > maxDepth) continue;
    const minC = Math.floor(depth * start + 0.5), maxC = Math.ceil(depth * end - 0.5);
    let prev = null;                          // null = no tile yet, true = wall, false = floor
    for (let c = minC; c <= maxC; c++) {
      const w = wall(depth, c);
      if (w || (c >= depth * start && c <= depth * end)) mark(tx(depth, c), ty(depth, c));
      if (prev === true && !w) start = (2 * c - 1) / (2 * depth);
      if (prev === false && w) stack.push([depth + 1, start, (2 * c - 1) / (2 * depth)]);
      prev = w;
    }
    if (prev === false) stack.push([depth + 1, start, end]);
  }
}

// grow a tile set by one tile in all eight directions
export function grow(tiles, by = 1) {
  const out = new Set(tiles);
  for (const t of tiles) {
    const i = t.indexOf(',');
    const x = +t.slice(0, i), y = +t.slice(i + 1);
    for (let dy = -by; dy <= by; dy++) for (let dx = -by; dx <= by; dx++) out.add((x + dx) + ',' + (y + dy));
  }
  return out;
}

export { K as tileKey };
