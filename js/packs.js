// Sprite packs: an ordered stack of sources. For every RSI state / texture the
// first pack that has it wins; whatever no pack has falls back to the dev texture.

export const DEV = { id: 'dev', name: 'Dev texture', type: 'dev', enabled: true };

// "Structures/Walls/solid.rsi", "/Textures/Tiles/steel.png" -> path relative to the Textures root
export function texRel(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  s = s.replace(/^\/+/, '');
  if (s.startsWith('Textures/')) s = s.slice(9);
  return s;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// small fetch queue so a big map doesn't fire thousands of requests at once
class Queue {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  run(fn) {
    return new Promise((res, rej) => {
      this.q.push({ fn, res, rej });
      this.pump();
    });
  }
  pump() {
    while (this.active < this.n && this.q.length) {
      const { fn, res, rej } = this.q.shift();
      this.active++;
      fn().then(res, rej).finally(() => { this.active--; this.pump(); });
    }
  }
}
const net = new Queue(24);

async function fetchBlob(url) {
  return net.run(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.status === 404) return null;
        if (r.ok) return await r.blob();
        if (r.status === 429 || r.status >= 500) { await sleep(500 * (attempt + 1)); continue; }
        return null;
      } catch (e) {
        await sleep(300 * (attempt + 1));
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------- pack sources
export class Pack {
  constructor(cfg, ctx) {
    this.cfg = cfg;
    this.ctx = ctx;               // { siteRepo, siteBranch, dbCommit }
    this.files = cfg.files || null; // Map for local folder packs
    this.hits = 0;
  }
  get id() { return this.cfg.id; }
  get name() { return this.cfg.name; }
  get type() { return this.cfg.type; }
  ref() {
    const r = this.cfg.ref || 'master';
    if (r === '{db}') return this.ctx.dbCommit || this.cfg.branch || 'master';
    const m = /^\{commit:([\w-]+)\}$/.exec(r);      // pinned to the commit a fork's database was built from
    if (m) return (this.ctx.commits && this.ctx.commits[m[1]]) || this.cfg.branch || 'master';
    return r;
  }
  root() { return (this.cfg.path || '').replace(/^\/+|\/+$/g, ''); }
  url(rel) {
    const root = this.root();
    const p = (root ? root + '/' : '') + rel;
    if (this.type === 'github') {
      return `https://raw.githubusercontent.com/${this.cfg.repo}/${this.ref()}/${encodePath(p)}`;
    }
    if (this.type === 'site') return encodePath(p);
    return null;
  }
  // link to the folder (or file) on GitHub, if this pack lives there
  link(rel, isDir) {
    const root = this.root();
    const p = (root ? root + '/' : '') + rel;
    if (this.type === 'github') {
      return `https://github.com/${this.cfg.repo}/${isDir ? 'tree' : 'blob'}/${this.ref()}/${encodePath(p)}`;
    }
    if (this.type === 'site' && this.ctx.siteRepo) {
      return `https://github.com/${this.ctx.siteRepo}/${isDir ? 'tree' : 'blob'}/${this.ctx.siteBranch || 'main'}/${encodePath(p)}`;
    }
    return null;
  }
  // the path a person would look for on disk / in the repo
  displayPath(rel) {
    if (this.type === 'local') return (this.cfg.folder ? this.cfg.folder + '/' : '') + rel;
    if (this.type === 'github') return `${this.cfg.repo}/${this.root()}/${rel}`;
    return (this.root() ? this.root() + '/' : '') + rel;
  }
  // packs stored in this repo carry an index.json listing their files, so we
  // don't ask the server for thousands of files that aren't there
  index() {
    if (this.type !== 'site') return Promise.resolve(null);
    if (!this._index) {
      this._index = (async () => {
        try {
          const r = await fetch(this.url('index.json'), { cache: 'no-cache' });
          if (!r.ok) return null;
          const j = await r.json();
          return {
            rsis: new Set((j.rsis || []).map(f => String(f).toLowerCase())),
            files: new Set((j.files || []).map(f => String(f).toLowerCase())),
          };
        } catch (e) { return null; }
      })();
    }
    return this._index;
  }
  async get(rel) {
    if (this.type === 'site') {
      const idx = await this.index();
      if (idx) {
        const lr = rel.toLowerCase();
        const i = lr.indexOf('.rsi/');
        const ok = idx.files.has(lr) || (i >= 0 && idx.rsis.has(lr.slice(0, i + 4)));
        if (!ok) return null;
      }
    }
    if (this.type === 'local') {
      const f = this.files && this.files.get(rel.toLowerCase());
      return f || null;
    }
    const u = this.url(rel);
    return u ? fetchBlob(u) : null;
  }
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// Build a local pack from <input webkitdirectory> files. Works whether the user picked
// Resources/, Resources/Textures/ or a folder of RSIs.
export function localPackFromFiles(fileList, name) {
  const files = Array.from(fileList);
  const paths = files.map(f => (f.webkitRelativePath || f.name).replace(/\\/g, '/'));
  let strip = null;
  for (const p of paths) {
    const i = p.indexOf('/Textures/');
    if (i >= 0) { strip = p.slice(0, i + 10); break; }
  }
  const top = paths.length ? paths[0].split('/')[0] : '';
  const map = new Map();
  files.forEach((f, i) => {
    let p = paths[i];
    if (strip && p.startsWith(strip)) p = p.slice(strip.length);
    else if (!strip) p = p.split('/').slice(1).join('/');
    else return;
    map.set(p.toLowerCase(), f);
  });
  return {
    id: 'local-' + Math.random().toString(36).slice(2, 8),
    name: name || top || 'Local folder', type: 'local', enabled: true,
    folder: strip ? strip.replace(/\/$/, '') : top, files: map,
  };
}

// ---------------------------------------------------------------- sprite store
// A resolved RSI state: { pack, img, w, h, dirs, frames(per dir), cols, rsi, state, meta }
export class SpriteStore {
  constructor() {
    this.packs = [];
    this.metaCache = new Map();   // packId|rsi -> Promise(meta|null)
    this.stateCache = new Map();  // rsi|state -> Promise(resolved)
    this.texCache = new Map();    // path -> Promise(resolved)
    this.devCache = new Map();
    this.alpha = new WeakMap();
    this.missing = new Map();     // key -> {rsi,state,count}
  }
  setPacks(packs) {
    this.packs = packs.filter(p => p.cfg.enabled !== false && p.type !== 'dev');
    this.stateCache.clear();
    this.texCache.clear();
    this.missing.clear();
    for (const p of this.packs) p.hits = 0;
  }
  dev(w = 32, h = 32) {
    const k = w + 'x' + h;
    if (this.devCache.has(k)) return this.devCache.get(k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const s = Math.max(4, Math.round(Math.min(w, h) / 4));
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
      g.fillStyle = ((x / s + y / s) & 1) ? '#FF00DC' : '#000000';
      g.fillRect(x, y, s, s);
    }
    const r = { pack: null, img: c, w, h, dirs: 1, frames: [1], cols: 1, dev: true };
    this.devCache.set(k, r);
    return r;
  }
  meta(pack, rsi) {
    const k = pack.id + '|' + rsi;
    if (!this.metaCache.has(k)) {
      this.metaCache.set(k, (async () => {
        const b = await pack.get(rsi + '/meta.json');
        if (!b) return null;
        try {
          const j = JSON.parse((await b.text()).replace(/^﻿/, ''));
          const states = new Map();
          for (const s of j.states || []) states.set(String(s.name), s);
          return { size: j.size || { x: 32, y: 32 }, states, raw: j };
        } catch (e) { return null; }
      })());
    }
    return this.metaCache.get(k);
  }
  async loadImage(blob) {
    try {
      return await createImageBitmap(blob);
    } catch (e) {
      return null;
    }
  }
  // resolve an RSI state through the pack stack
  state(rsiPath, state) {
    const rsi = texRel(rsiPath);
    const key = rsi + '|' + state;
    if (!this.stateCache.has(key)) {
      this.stateCache.set(key, (async () => {
        for (const pack of this.packs) {
          const m = await this.meta(pack, rsi);
          if (!m) continue;
          const st = m.states.get(String(state));
          if (!st) continue;
          const blob = await pack.get(rsi + '/' + state + '.png');
          if (!blob) continue;
          const img = await this.loadImage(blob);
          if (!img) continue;
          pack.hits++;
          const w = m.size.x || 32, h = m.size.y || 32;
          const dirs = st.directions || 1;
          const frames = [];
          for (let d = 0; d < dirs; d++) frames.push(st.delays && st.delays[d] ? st.delays[d].length : 1);
          return { pack, img, blob, w, h, dirs, frames, cols: Math.max(1, Math.floor(img.width / w)),
            rsi, state: String(state), metaRaw: m.raw };
        }
        const mk = rsi + '|' + state;
        const r = { ...this.dev(), rsi, state: String(state) };
        if (!this.missing.has(mk)) this.missing.set(mk, { rsi, state: String(state), count: 0, protos: new Set() });
        return r;
      })());
    }
    return this.stateCache.get(key);
  }
  // resolve a plain texture (.png path)
  texture(path) {
    const rel = texRel(path);
    if (!this.texCache.has(rel)) {
      this.texCache.set(rel, (async () => {
        for (const pack of this.packs) {
          const blob = await pack.get(rel);
          if (!blob) continue;
          const img = await this.loadImage(blob);
          if (!img) continue;
          pack.hits++;
          return { pack, img, blob, w: img.width, h: img.height, dirs: 1, frames: [1], cols: 1, tex: rel };
        }
        if (!this.missing.has(rel)) this.missing.set(rel, { tex: rel, count: 0, protos: new Set() });
        return { ...this.dev(), tex: rel };
      })());
    }
    return this.texCache.get(rel);
  }
  // source rect of the first frame for a direction index (RSI order: S, N, E, W, SE, SW, NE, NW)
  frameRect(r, dir) {
    if (r.dev || r.tex) return { sx: 0, sy: 0, sw: r.img.width, sh: r.img.height };
    const d = Math.min(dir || 0, r.dirs - 1);
    let idx = 0;
    for (let i = 0; i < d; i++) idx += r.frames[i];
    return { sx: (idx % r.cols) * r.w, sy: Math.floor(idx / r.cols) * r.h, sw: r.w, sh: r.h };
  }
  // alpha test for picking
  alphaAt(img, x, y) {
    let a = this.alpha.get(img);
    if (!a) {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      a = { w: img.width, d: g.getImageData(0, 0, img.width, img.height).data };
      this.alpha.set(img, a);
    }
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= a.w) return 0;
    return a.d[(y * a.w + x) * 4 + 3] || 0;
  }
}
