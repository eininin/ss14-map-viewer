// Space background like the game's "Default" parallax: the nebula image (layer1.png)
// plus four procedurally generated star layers (ports of the engine's .toml recipes),
// each layer drifting at its own speed as the camera moves.

const SIZE = 1024;   // generated star tile size (px), repeated across the screen

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tileable value noise + fbm, used as the "mask" that clusters stars into nebula bands
function makeNoise(seed) {
  const r = rng(seed), N = 256, perm = new Uint8Array(N * 2), val = new Float32Array(N);
  for (let i = 0; i < N; i++) { perm[i] = i; val[i] = r(); }
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const lat = (x, y, p) => val[perm[(perm[((x % p) + p) % p] + ((y % p) + p) % p) & 255]];
  const sm = (t) => t * t * (3 - 2 * t);
  const noise = (x, y, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const a = lat(xi, yi, p), b = lat(xi + 1, yi, p), c = lat(xi, yi + 1, p), d = lat(xi + 1, yi + 1, p);
    const u = sm(xf), v = sm(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, y, o) => {   // x,y in 0..1 (tile space)
    let f = o.frequency, amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < o.octaves; i++) {
      const p = Math.max(1, Math.round(f));
      sum += amp * (noise(x * p, y * p, p) * 2 - 1);
      norm += amp;
      amp *= o.persistence;
      f *= o.lacunarity;
    }
    const v = (sum / norm + 1) / 2;
    return Math.pow(Math.max(0, v), o.power);
  };
}

function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// one generated layer: list of point passes, as in the .toml files
function generate(passes) {
  const img = new ImageData(SIZE, SIZE);
  const d = img.data;
  const put = (x, y, rgb) => {
    x = ((x % SIZE) + SIZE) % SIZE; y = ((y % SIZE) + SIZE) % SIZE;
    const i = (y * SIZE + x) * 4;
    // keep the brighter colour where points overlap
    if (rgb[0] + rgb[1] + rgb[2] < d[i] + d[i + 1] + d[i + 2]) return;
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
  };
  // dim edges (pointsize 2) first so the bright centres sit on top
  const ordered = passes.slice().sort((a, b) => (b.size || 1) - (a.size || 1));
  for (const ps of ordered) {
    const r = rng(ps.seed), rgb = hex(ps.color);
    const mask = ps.mask ? makeNoise(ps.mask.seed) : null;
    let placed = 0, tries = 0;
    while (placed < ps.count && tries < ps.count * 40) {
      tries++;
      const x = Math.floor(r() * SIZE), y = Math.floor(r() * SIZE);
      if (mask && mask(x / SIZE, y / SIZE, ps.mask) < ps.mask.threshold) continue;
      placed++;
      if ((ps.size || 1) >= 2) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) put(x + dx, y + dy, rgb); }
      else put(x, y, rgb);
    }
  }
  // colour to alpha: black is see-through, brightness becomes opacity
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.max(d[i], d[i + 1], d[i + 2]);
    if (!m) { d[i + 3] = 0; continue; }
    d[i + 3] = m;
    d[i] = Math.min(255, d[i] * 255 / m); d[i + 1] = Math.min(255, d[i + 1] * 255 / m); d[i + 2] = Math.min(255, d[i + 2] * 255 / m);
  }
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

const NEBULA_MASK = (seed, threshold) => ({ seed, threshold, octaves: 4, persistence: 0.5, power: 0.35, lacunarity: 1.5, frequency: 3 });
// parallax_config_stars.toml, _stars_dim.toml, _stars-2.toml, _stars_dim-2.toml
const STAR_LAYERS = [
  { slowness: 0.996625, passes: [
    { color: '#7E86BF', count: 1000, seed: 3472, mask: NEBULA_MASK(3551, 0.37) },
    { color: '#3D415C', size: 2, count: 1000, seed: 3472, mask: NEBULA_MASK(3551, 0.37) },
    { color: '#FFD363', count: 30, seed: 6454 },
    { color: '#43371A', size: 2, count: 30, seed: 6454 }] },
  { slowness: 0.989375, passes: [
    { color: '#4B5072', count: 1500, seed: 3909, mask: NEBULA_MASK(3551, 0.0) },
    { color: '#7E86BF', count: 250, seed: 6843, mask: NEBULA_MASK(2938, 0.37) },
    { color: '#3D415C', size: 2, count: 250, seed: 6843, mask: NEBULA_MASK(2938, 0.37) },
    { color: '#FFD363', count: 15, seed: 3748 },
    { color: '#43371A', size: 2, count: 15, seed: 3748 }] },
  { slowness: 0.987265625, passes: [
    { color: '#7E86BF', count: 1000, seed: 4810, mask: NEBULA_MASK(3551, 0.37) },
    { color: '#3D415C', size: 2, count: 1000, seed: 4810, mask: NEBULA_MASK(3551, 0.37) },
    { color: '#FFD363', count: 30, seed: 9019 },
    { color: '#43371A', size: 2, count: 30, seed: 9019 }] },
  { slowness: 0.984352, passes: [
    { color: '#4B5072', count: 1500, seed: 4920, mask: NEBULA_MASK(6734, 0.0) },
    { color: '#7E86BF', count: 250, seed: 5848, mask: NEBULA_MASK(8398, 0.37) },
    { color: '#3D415C', size: 2, count: 250, seed: 5848, mask: NEBULA_MASK(8398, 0.37) },
    { color: '#FFD363', count: 15, seed: 3748 },
    { color: '#43371A', size: 2, count: 15, seed: 3748 }] },
];

export class Parallax {
  constructor() {
    this.layers = null;     // [{img, slowness, scale}]
    this.nebula = null;
  }
  // build the star layers (once) and ask for the nebula image through the sprite packs
  async init(store) {
    if (!this.layers) {
      this.layers = STAR_LAYERS.map(l => ({ img: generate(l.passes), slowness: l.slowness, scale: 1 }));
    }
    try {
      const r = await store.texture('/Textures/Parallaxes/layer1.png');
      this.nebula = r && !r.dev ? { img: r.img, slowness: 0.998046875, scale: 1 } : null;
    } catch (e) { this.nebula = null; }
  }
  get ready() { return !!this.layers; }
  // camX/camY in tiles; the game moves a layer by (1 - slowness) of the camera motion, 32 px per tile
  draw(g, w, h, camX, camY, dpr) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w * dpr, h * dpr);
    if (!this.layers) return;
    g.imageSmoothingEnabled = false;
    const all = this.nebula ? [this.nebula, ...this.layers] : this.layers;
    for (const L of all) {
      const tw = L.img.width * L.scale * dpr, th = L.img.height * L.scale * dpr;
      const k = (1 - L.slowness) * 32 * dpr;
      let ox = -camX * k, oy = camY * k;
      ox = ((ox % tw) + tw) % tw - tw; oy = ((oy % th) + th) % th - th;
      for (let y = oy; y < h * dpr; y += th) for (let x = ox; x < w * dpr; x += tw) g.drawImage(L.img, x, y, tw, th);
    }
  }
}
