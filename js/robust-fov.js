// The game's field of view, ported from Starlight's engine (ss14Starlight/RobustToolbox 5278296):
//  - ClientOccluderSystem: which occluder edges are shared with a touching occluder (the edge mask)
//  - Clyde.LightRendering.cs: the occluder edges, ShouldSuppressSharedOccluderEdge and its corner rules
//  - shadow-depth.vert/.frag: a 1D polar depth map (2048 wide) per row, drawn twice per row
//    (shadowOverlapSide 0 and 1), nearest edge by the depth test
//  - DrawFov: row 0 with back faces culled (lighting), row 1 with front faces culled (final FOV, so you
//    see "into" walls)
//  - fov.swsl: final FOV, black where depth - 0.75/32 < distance (nearest sampling)
//  - fov-lighting.swsl: lighting FOV, variance shadow map (Chebyshev) with linear sampling
// Coordinates are the grid's own (y up), which is the engine's world space up to a rigid transform.

export const FOV_MAP_SIZE = 2048;                       // Clyde FovMapSize
const TOL = 0.001, TOL2 = TOL * TOL;                    // SharedOccluderEdgeTolerance
const PAD = 1 + TOL;                                    // SharedOccluderNeighbourQueryPadding
const ARBITRARY_DISTANCE_MAX = 1234;                    // PrepareDepthDraw clear colour
const DEPTH_LEFTRIGHT_EXPAND_BIAS = 0.001;
const DEPTH_ZBUFFER_PREDIV_BIAS = 1.0;
const FOV_BIAS = -0.75 / 32;                            // fov.swsl doesOcclude bias

const quant = (v) => Math.round(v / TOL);
const vKeyQ = (X, Y) => X + ',' + Y;
const vKey = (x, y) => vKeyQ(quant(x), quant(y));       // OccluderVertexKey
function eKeyArr(e) {                                   // OccluderEdgeKey
  let ax = quant(e[0]), ay = quant(e[1]), bx = quant(e[2]), by = quant(e[3]);
  if (ax > bx || (ax === bx && ay > by)) return [bx, by, ax, ay];
  return [ax, ay, bx, by];
}
const eKey = (e) => eKeyArr(e).join(',');
const cross = (ax, ay, bx, by) => ax * by - ay * bx;

function signedArea(v) {
  let a = 0;
  for (let i = 0; i < v.length; i++) { const j = (i + 1) % v.length; a += v[i][0] * v[j][1] - v[i][1] * v[j][0]; }
  return a * 0.5;
}

// PhysicsHullSerializer stores the convex hull of the given points
function hull(points) {
  const p = points.map(q => [+q[0], +q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

const DEFAULT_POLYGON = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];   // OccluderComponent default

// ---------------------------------------------------------------- source-independent geometry (cached)
// items: scene items; an occluder is an entity with info.oc (closed doors only). info.ocp: its polygon.
export function buildOccluderGeometry(items, grid) {
  const occ = [];
  for (const it of items) {
    if (it.kind !== 'ent' || it.grid !== grid || !it.info || !it.info.oc) continue;
    if (it.info.door != null && it.door === 'open') continue;           // open doors disable their occluder
    const poly = it.info.ocp ? hull(it.info.ocp) : DEFAULT_POLYGON;
    if (poly.length < 3) continue;
    const rot = (it.rot || 0) - (it.info.r || 0);      // the entity's own rotation
    const c = Math.cos(rot), s = Math.sin(rot);
    // occluder polygons are CCW physics hulls; the depth shader wants clockwise edges
    const clockwise = signedArea(poly) < 0;
    const verts = [];
    for (let i = 0; i < poly.length; i++) {
      const [px, py] = poly[clockwise ? i : poly.length - 1 - i];
      verts.push([it.x + px * c - py * s, it.y + px * s + py * c]);
    }
    const edges = verts.map((v, i) => { const w = verts[(i + 1) % verts.length]; return [v[0], v[1], w[0], w[1]]; });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of verts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    occ.push({ verts, edges, keys: edges.map(eKeyArr), mask: 0, x0, y0, x1, y1 });
  }
  sharedMasks(occ);
  return finishGeometry(occ);
}

function sharedMasks(occ) {
  // ClientOccluderSystem: bit i set when edge i is shared with another enabled occluder's edge
  const cell = new Map(), ck = (x, y) => x + ',' + y;
  occ.forEach((o, n) => {
    for (let x = Math.floor(o.x0); x <= Math.floor(o.x1); x++) for (let y = Math.floor(o.y0); y <= Math.floor(o.y1); y++) {
      const k = ck(x, y); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(n);
    }
  });
  const near = (a, b) => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[2] - b[2]) <= 1 && Math.abs(a[3] - b[3]) <= 1;
  occ.forEach((o, n) => {
    const qx0 = o.x0 - PAD, qy0 = o.y0 - PAD, qx1 = o.x1 + PAD, qy1 = o.y1 + PAD, done = new Set([n]);
    for (let x = Math.floor(qx0); x <= Math.floor(qx1); x++) for (let y = Math.floor(qy0); y <= Math.floor(qy1); y++) {
      for (const m of cell.get(ck(x, y)) || []) {
        if (done.has(m)) continue;
        done.add(m);
        const p = occ[m];
        if (p.x1 < qx0 || p.x0 > qx1 || p.y1 < qy0 || p.y0 > qy1) continue;
        for (let i = 0; i < o.keys.length; i++) {
          for (const k of p.keys) if (near(o.keys[i], k)) { o.mask |= 1 << i; break; }
        }
      }
    }
  });
}

function finishGeometry(occ) {
  // AddOccluderBoundaryEdges, BuildSharedVertexEdges, BuildConvexBoundaryVertices
  const segments = [], sharedEdges = new Set();
  for (const o of occ) o.edges.forEach((e, i) => { segments.push(e); if (o.mask & (1 << i)) sharedEdges.add(eKey(e)); });
  const sharedVertexEdges = new Map(), unique = new Set();
  const addSV = (x, y, e) => { const k = vKey(x, y); if (!sharedVertexEdges.has(k)) sharedVertexEdges.set(k, []); sharedVertexEdges.get(k).push(e); };
  for (const e of segments) {
    const k = eKey(e);
    if (!sharedEdges.has(k) || unique.has(k)) continue;
    unique.add(k);
    addSV(e[0], e[1], e); addSV(e[2], e[3], e);
  }
  const dirs = new Map();
  for (const e of segments) {
    if (sharedEdges.has(eKey(e))) continue;
    const dx = e[2] - e[0], dy = e[3] - e[1];
    const a = vKey(e[0], e[1]), b = vKey(e[2], e[3]);
    const da = dirs.get(a) || { inc: null, out: null, ni: 0, no: 0 }; da.out = [dx, dy]; da.no++; dirs.set(a, da);
    const db = dirs.get(b) || { inc: null, out: null, ni: 0, no: 0 }; db.inc = [dx, dy]; db.ni++; dirs.set(b, db);
  }
  const convex = new Set();
  for (const [k, d] of dirs) {
    if (d.ni !== 1 || d.no !== 1) continue;
    if (cross(d.inc[0], d.inc[1], d.out[0], d.out[1]) < -TOL) convex.add(k);
  }
  return { occ, segments, sharedEdges, sharedVertexEdges, convex };
}

// Several grids' geometry moved into one space (each part: geom + f(x, y) -> [X, Y], a rigid transform).
// Only occluders whose bounds meet `keep(x0, y0, x1, y1)` (in the new space) are taken.
export function transformedGeometry(parts, keep) {
  const occ = [];
  for (const { geom, f } of parts) {
    for (const o of geom.occ) {
      const verts = o.verts.map(([x, y]) => f(x, y));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of verts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      if (keep && !keep(x0, y0, x1, y1)) continue;
      const edges = verts.map((v, i) => { const w = verts[(i + 1) % verts.length]; return [v[0], v[1], w[0], w[1]]; });
      occ.push({ verts, edges, keys: edges.map(eKeyArr), mask: o.mask, x0, y0, x1, y1, inView: true });
    }
  }
  return finishGeometry(occ);
}

// IsLightEmbeddedInOccluder: the point is inside (or on) an occluder's polygon
export function embeddedInOccluder(geom, px, py) {
  for (const o of geom.occ) {
    if (px < o.x0 - TOL || px > o.x1 + TOL || py < o.y0 - TOL || py > o.y1 + TOL) continue;
    let inside = true;
    for (const e of o.edges) {                          // clockwise: inside is on the right of every edge
      if (cross(e[2] - e[0], e[3] - e[1], px - e[0], py - e[1]) > 0) { inside = false; break; }
    }
    if (inside) return true;
  }
  return false;
}

// UploadSourceOcclusionDepthGeometry: the edges that go into the depth maps for this eye
// (occluders in the box x0..x1, y0..y1; the boundary topology uses everything in geom)
export function depthEdges(geom, ex, ey, x0, y0, x1, y1) {
  const visible = new Set();                            // BuildVisibleBoundaryVertices
  for (const e of geom.segments) {
    if (geom.sharedEdges.has(eKey(e)) || !edgeFacesPoint(e, ex, ey)) continue;
    visible.add(vKey(e[0], e[1])); visible.add(vKey(e[2], e[3]));
  }
  const draw = [];
  for (const o of geom.occ) {
    if (o.x1 < x0 || o.x0 > x1 || o.y1 < y0 || o.y0 > y1) continue;
    const shared = o.edges.map((_, i) => (o.mask & (1 << i)) !== 0);
    for (let i = 0; i < o.edges.length; i++) {
      if (shouldSuppress(i, o.edges, shared, visible, geom.convex, geom.sharedVertexEdges, ex, ey)) continue;
      draw.push(o.edges[i]);
    }
  }
  return draw;
}

// ---------------------------------------------------------------- source-dependent rules
const edgeFacesPoint = (e, px, py) => cross(e[0] - px, e[1] - py, e[2] - px, e[3] - py) > 0;
const pointsMatch = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by) <= TOL2;

function hasBoundaryVertex(x, y, set) {
  const X = quant(x), Y = quant(y);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (set.has(vKeyQ(X + dx, Y + dy))) return true;
  return false;
}

function forNearShared(jx, jy, cur, sve, fn) {
  const X = quant(jx), Y = quant(jy), curKey = eKey(cur);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const list = sve.get(vKeyQ(X + dx, Y + dy));
    if (!list) continue;
    for (const c of list) {
      if (eKey(c) === curKey) continue;
      let fx, fy;
      if (pointsMatch(c[0], c[1], jx, jy)) { fx = c[2] - jx; fy = c[3] - jy; }
      else if (pointsMatch(c[2], c[3], jx, jy)) { fx = c[0] - jx; fy = c[1] - jy; }
      else continue;
      if (fn(fx, fy)) return true;
    }
  }
  return false;
}

function hasOppositeCollinearSharedEdge(jx, jy, cx, cy, cur, sve) {
  const cl2 = cx * cx + cy * cy;
  return forNearShared(jx, jy, cur, sve, (fx, fy) => {
    const l2 = fx * fx + fy * fy;
    if (l2 <= TOL2) return false;
    const cr = cross(cx, cy, fx, fy);
    if (cr * cr > TOL2 * cl2 * l2) return false;
    return cx * fx + cy * fy < 0;
  });
}

function sharedEdgeContinuesThroughEyeProjection(e, sve, ex, ey) {
  const ax = e[0], ay = e[1], bx = e[2], by = e[3];
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (l2 <= TOL2) return false;
  const fx = ex - ax, fy = ey - ay;
  const sa = cross(dx, dy, fx, fy);
  if (sa * sa <= TOL2 * l2) return false;
  const proj = (fx * dx + fy * dy) / l2;
  if (Math.abs(proj) <= TOL) return hasOppositeCollinearSharedEdge(ax, ay, dx, dy, e, sve);
  if (Math.abs(proj - 1) <= TOL) return hasOppositeCollinearSharedEdge(bx, by, -dx, -dy, e, sve);
  return false;
}

function sharedEdgeTurnsAwayFromEyeAtCorner(e, sve, ex, ey) {
  const ax = e[0], ay = e[1], bx = e[2], by = e[3];
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  if (l2 <= TOL2) return false;
  const proj = ((ex - ax) * dx + (ey - ay) * dy) / l2;
  if (proj > TOL && proj < 1 - TOL) return false;
  const atA = proj <= TOL;
  const jx = atA ? ax : bx, jy = atA ? ay : by;
  const cx = atA ? bx - ax : ax - bx, cy = atA ? by - ay : ay - by;
  const cl2 = cx * cx + cy * cy;
  const fx = ex - jx, fy = ey - jy;
  if (fx * fx + fy * fy <= TOL2) return false;
  return forNearShared(jx, jy, e, sve, (ox, oy) => {
    const ol2 = ox * ox + oy * oy;
    if (ol2 <= TOL2) return false;
    const cr = cross(cx, cy, ox, oy);
    if (cr * cr <= TOL2 * cl2 * ol2) return false;
    // the shared edge is one side of a shared corner; eye opposite the corner's outgoing wedge: behind a wall
    const wx = cx + ox, wy = cy + oy;
    if (wx * wx + wy * wy <= TOL2) return false;
    return fx * wx + fy * wy < 0;
  });
}

function edgeViewedAsCap(e, ex, ey) {
  const ax = e[0], ay = e[1];
  const dx = e[2] - ax, dy = e[3] - ay, l2 = dx * dx + dy * dy;
  if (l2 <= TOL2) return false;
  const fx = ex - ax, fy = ey - ay;
  const proj = (fx * dx + fy * dy) / l2;
  if (proj <= TOL || proj >= 1 - TOL) return false;
  const sa = cross(dx, dy, fx, fy);
  return sa * sa > TOL2 * l2;
}

function shouldSuppress(i, edges, shared, visible, convex, sve, ex, ey) {
  if (!shared[i]) return false;
  const e = edges[i];
  if (edgeViewedAsCap(e, ex, ey)
    || sharedEdgeContinuesThroughEyeProjection(e, sve, ex, ey)
    || (edges.length === 3 && sharedEdgeTurnsAwayFromEyeAtCorner(e, sve, ex, ey))) return false;
  const prev = i === 0 ? edges.length - 1 : i - 1, next = i + 1 === edges.length ? 0 : i + 1;
  let startVisible = !shared[prev] && edgeFacesPoint(edges[prev], ex, ey);
  if (!startVisible && hasBoundaryVertex(e[0], e[1], convex)) startVisible = hasBoundaryVertex(e[0], e[1], visible);
  let endVisible = !shared[next] && edgeFacesPoint(edges[next], ex, ey);
  if (!endVisible && hasBoundaryVertex(e[2], e[3], convex)) endVisible = hasBoundaryVertex(e[2], e[3], visible);
  return startVisible || endVisible;
}

// ---------------------------------------------------------------- the depth map (shadow-depth.vert/.frag)
function rasterEdge(row, e, lx, ly, side, keepFront) {
  const W = FOV_MAP_SIZE, PI = Math.PI;
  // aPos is clockwise, the shader swaps to anticlockwise
  const pAx = e[2] - lx, pAy = e[3] - ly, pBx = e[0] - lx, pBy = e[1] - ly;
  let xA = Math.atan2(pAy, -pAx), xB = Math.atan2(pBy, -pBx);
  const bias = Math.sign(xB - xA) * DEPTH_LEFTRIGHT_EXPAND_BIAS;
  xA -= bias; xB += bias;
  if (Math.abs(xA - xB) >= PI) {
    if (side < 0.5) xA += Math.sign(xB - xA) * PI * 2;
    else xB += Math.sign(xA - xB) * PI * 2;
  }
  if (xA === xB) return;
  // quad (xB,-1) (xA,-1) (xA,1) (xB,1): clockwise (front, FrontFace Cw) when xA < xB
  const front = xA < xB;
  if (front !== keepFront) return;
  let nx = pBx - pAx, ny = pBy - pAy;
  const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
  const ang = Math.atan2(nx, ny), pd = ny * pAx - nx * pAy;
  const zA = 1 - 1 / (Math.hypot(pAx, pAy) + DEPTH_ZBUFFER_PREDIV_BIAS);
  const zB = 1 - 1 / (Math.hypot(pBx, pBy) + DEPTH_ZBUFFER_PREDIV_BIAS);
  const nA = xA / PI, nB = xB / PI, lo = Math.min(nA, nB), hi = Math.max(nA, nB);
  const i0 = Math.max(0, Math.ceil((lo + 1) * W / 2 - 0.5)), i1 = Math.min(W - 1, Math.ceil((hi + 1) * W / 2 - 0.5) - 1);
  const dist = (i) => Math.abs(pd / Math.cos((-1 + (2 * i + 1) / W) * PI - ang));
  for (let i = i0; i <= i1; i++) {
    const c = -1 + (2 * i + 1) / W;
    const z = zA + (zB - zA) * (c - nA) / (nB - nA);
    if (z > row.z[i]) continue;                         // DepthFunc Lequal
    const d = dist(i), b = i & ~1;
    const dx = dist(b + 1) - dist(b);                     // dFdx over the 2x2 quad; dFdy is 0 on a 1-pixel row
    row.z[i] = z; row.d[i] = d; row.m2[i] = d * d + 0.25 * dx * dx;
  }
}

function newRow() {
  const W = FOV_MAP_SIZE;
  return { z: new Float64Array(W).fill(1), d: new Float64Array(W).fill(ARBITRARY_DISTANCE_MAX),
    m2: new Float64Array(W).fill(ARBITRARY_DISTANCE_MAX * ARBITRARY_DISTANCE_MAX) };
}

// geom from buildOccluderGeometry; eye (ex, ey); only occluders within `range` of the eye are drawn
export function computeFov(geom, ex, ey, range) {
  const visible = new Set();                            // BuildVisibleBoundaryVertices
  const bx0 = ex - range - 2, bx1 = ex + range + 2, by0 = ey - range - 2, by1 = ey + range + 2;
  for (const e of geom.segments) {
    if (Math.max(e[0], e[2]) < bx0 || Math.min(e[0], e[2]) > bx1 || Math.max(e[1], e[3]) < by0 || Math.min(e[1], e[3]) > by1) continue;
    if (geom.sharedEdges.has(eKey(e)) || !edgeFacesPoint(e, ex, ey)) continue;
    visible.add(vKey(e[0], e[1])); visible.add(vKey(e[2], e[3]));
  }
  const draw = [];                                       // UploadSourceOcclusionDepthGeometry
  for (const o of geom.occ) {
    if (o.x1 < ex - range || o.x0 > ex + range || o.y1 < ey - range || o.y0 > ey + range) continue;
    const shared = o.edges.map((_, i) => (o.mask & (1 << i)) !== 0);
    for (let i = 0; i < o.edges.length; i++) {
      if (shouldSuppress(i, o.edges, shared, visible, geom.convex, geom.sharedVertexEdges, ex, ey)) continue;
      draw.push(o.edges[i]);
    }
  }
  // DrawFov: row 0 culls back faces (lighting), row 1 culls front faces (final FOV); two draw calls each
  const rows = [newRow(), newRow()];
  for (const [r, keepFront] of [[0, true], [1, false]]) {
    for (const side of [0, 1]) for (const e of draw) rasterEdge(rows[r], e, ex, ey, side, keepFront);
  }
  return { ex, ey, rows };
}

// fov.swsl: the area that is not blacked out, as a polygon (one wedge per depth-map column)
export function fovPolygon(fov, maxR) {
  const W = FOV_MAP_SIZE, d = fov.rows[1].d, pts = [];
  for (let i = 0; i < W; i++) {
    const r = Math.max(0, Math.min(maxR, d[i] + FOV_BIAS));
    for (const t of [i, i + 1]) {
      const th = Math.PI * (-1 + 2 * t / W);
      pts.push(fov.ex - Math.cos(th) * r, fov.ey + Math.sin(th) * r);
    }
  }
  return pts;
}

// fov-lighting.swsl at a point: 1 = lit normally; below 1 the lighting is darkened and no lights drawn
export function lightingOcclusion(fov, x, y) {
  const W = FOV_MAP_SIZE, row = fov.rows[0];
  const rx = x - fov.ex, ry = y - fov.ey, t = Math.sqrt(rx * rx + ry * ry);
  const u = (Math.atan2(ry, -rx) / Math.PI + 1) / 2;
  const tx = u * W - 0.5, i0 = Math.floor(tx), f = tx - i0;
  const a = Math.min(W - 1, Math.max(0, i0)), b = Math.min(W - 1, Math.max(0, i0 + 1));
  const m1 = row.d[a] + (row.d[b] - row.d[a]) * f, m2 = row.m2[a] + (row.m2[b] - row.m2[a]) * f;
  // ChebyshevUpperBound with g_MinVariance 0
  if (t <= m1) return 1;
  const p = 0;
  const variance = Math.max(m2 - m1 * m1, 0);
  const dd = t - m1;
  const pMax = variance / (variance + dd * dd);
  return Math.max(p, pMax);
}
