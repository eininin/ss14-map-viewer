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

// ---------------------------------------------------------------- geometric view
// The view as straight-edged shapes: from each corner of the source area (where its outline
// turns), rays go to every outer corner of the sight-blocking tiles and stop on the first one
// they hit. Together they give the widest angle through every window and opening.

const EPS = 1e-4;

export function castRay(opaque, px, py, dx, dy, maxT) {
  let x = Math.floor(px), y = Math.floor(py);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? 1 / Math.abs(dx) : Infinity, tdy = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? x + 1 - px : px - x) * tdx : Infinity;
  let ty = dy !== 0 ? (dy > 0 ? y + 1 - py : py - y) * tdy : Infinity;
  for (;;) {
    let t;
    if (Math.abs(tx - ty) < 1e-9 * Math.max(1, tx)) {
      // through a tile corner: two walls touching only at that corner still block
      t = tx;
      if (t >= maxT) return maxT;
      const a = opaque.has(K(x + sx, y)), b = opaque.has(K(x, y + sy));
      if (a && b) return t;
      tx += tdx; ty += tdy; x += sx; y += sy;
    } else if (tx < ty) { t = tx; tx += tdx; x += sx; } else { t = ty; ty += tdy; y += sy; }
    if (t >= maxT) return maxT;
    // as in the game, the wall itself is seen: the line ends where it leaves the first wall
    if (opaque.has(K(x, y))) return Math.min(maxT, tx, ty);
  }
}

// corners where the outline of a tile set turns (1 or 3 of the 4 tiles around it, or 2 diagonal)
function turningCorners(has, tiles) {
  const out = new Map();
  for (const k of tiles) {
    const x = KX(k), y = KY(k);
    for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      const ck = K(cx, cy);
      if (out.has(ck)) continue;
      const a = has(cx - 1, cy - 1), b = has(cx, cy - 1), c = has(cx - 1, cy), d = has(cx, cy);
      const n = a + b + c + d;
      if (n === 1 || n === 3 || (n === 2 && a === d)) out.set(ck, [cx, cy, a, b, c, d]);
      else out.set(ck, null);
    }
  }
  return [...out.values()].filter(Boolean);
}

function outlineCorners(has, tiles) {
  const out = new Map();
  for (const k of tiles) {
    const x = KX(k), y = KY(k);
    for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      const ck = K(cx, cy);
      if (out.has(ck)) continue;
      const a = has(cx - 1, cy - 1), b = has(cx, cy - 1), c = has(cx - 1, cy), d = has(cx, cy);
      out.set(ck, a + b + c + d < 4 ? [cx, cy, a, b, c, d] : null);
    }
  }
  return [...out.values()].filter(Boolean);
}

/**
 * @returns {{polys: Float64Array[], viewpoints: number}}  polygons in grid tile units
 */
export function viewPolygons(o) {
  const { opaque } = o;
  const [bx0, by0, bx1, by1] = o.bounds;
  const src = new Set();
  for (const s of o.source) {
    const i = s.indexOf(',');
    const k = K(+s.slice(0, i), +s.slice(i + 1));
    if (!opaque.has(k)) src.add(k);
  }
  const inSrc = (x, y) => src.has(K(x, y)) ? 1 : 0;
  const isOpq = (x, y) => opaque.has(K(x, y)) ? 1 : 0;
  // eye points: every tile corner on the source outline, nudged a hair into the source
  const eyes = [];
  for (const [cx, cy, a, b, c, d] of outlineCorners(inSrc, src)) {
    let ix = 0, iy = 0;
    if (a) { ix -= 1; iy -= 1; } if (b) { ix += 1; iy -= 1; } if (c) { ix -= 1; iy += 1; } if (d) { ix += 1; iy += 1; }
    const l = Math.hypot(ix, iy) || 1;
    eyes.push([cx + ix / l * 0.02, cy + iy / l * 0.02]);
  }
  // targets: outer corners of everything that blocks sight
  const targets = turningCorners(isOpq, opaque).map(c => [c[0], c[1]]);
  const span = Math.hypot(bx1 - bx0, by1 - by0) + 4;
  const maxT = o.range > 0 ? Math.min(o.range, span) : span;
  const polys = eyes.map(([px, py]) => eyePolygon(opaque, targets, px, py, maxT));
  return { polys, viewpoints: eyes.length, targets, maxT };
}

// what one point sees: a star-shaped polygon (flat x,y list, grid tile units)
export function eyePolygon(opaque, targets, px, py, maxT) {
  const angles = [];
  for (const [tx, ty] of targets) {
    const ddx = tx - px, ddy = ty - py;
    if (ddx * ddx + ddy * ddy > maxT * maxT) continue;
    const a = Math.atan2(ddy, ddx);
    angles.push(a - EPS, a, a + EPS);
  }
  for (let i = 0; i < 720; i++) angles.push(-Math.PI + i * Math.PI / 360);
  angles.sort((p, q) => p - q);
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    const t = castRay(opaque, px, py, dx, dy, maxT);
    pts.push(px + dx * t, py + dy * t);
  }
  return simplify(pts);
}

// drop points lying on a straight line between their neighbours
function simplify(p) {
  const n = p.length / 2;
  if (n < 4) return Float64Array.from(p);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, c = (i + 1) % n;
    const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[i * 2], by = p[i * 2 + 1], cx = p[c * 2], cy = p[c * 2 + 1];
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9) continue;                                   // same point twice
    // keep the point unless it lies on the line between its neighbours (and between them)
    if (lv < 1e-9 || Math.abs(ux * vy - uy * vx) > 1e-9 * lu * lv || ux * vx + uy * vy < 0) out.push(bx, by);
  }
  return Float64Array.from(out);
}

// outer corners of everything that blocks sight (what rays are aimed at)
export function sightTargets(opaque) {
  return turningCorners((x, y) => opaque.has(K(x, y)) ? 1 : 0, opaque).map(c => [c[0], c[1]]);
}
