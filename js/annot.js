// Drawing layer over the map: coloured lines, an eraser that cuts lines, and text.
// Everything is stored in world coordinates (tiles), so it stays put when you zoom.

export class Annotations {
  constructor(onChange) {
    this.items = [];      // {t:'line', color, w, pts:[x,y,...]} | {t:'text', x, y, text, color, size}
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange || (() => {});
    this.visible = true;
  }
  snapshot() {
    this.undoStack.push(JSON.stringify(this.items));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.items));
    this.items = JSON.parse(this.undoStack.pop());
    this.onChange();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.items));
    this.items = JSON.parse(this.redoStack.pop());
    this.onChange();
  }
  clear() { if (!this.items.length) return; this.snapshot(); this.items = []; this.onChange(); }
  load(items) { this.items = Array.isArray(items) ? items : []; this.undoStack = []; this.redoStack = []; this.onChange(); }
  toJSON() { return { v: 1, items: this.items }; }

  // --- lines
  beginLine(x, y, color, w) {
    this.snapshot();
    this.cur = { t: 'line', color, w, pts: [x, y] };
    this.items.push(this.cur);
  }
  extendLine(x, y, minStep) {
    if (!this.cur) return;
    const p = this.cur.pts, n = p.length;
    if (Math.hypot(x - p[n - 2], y - p[n - 1]) < minStep) return;
    p.push(x, y);
  }
  endLine() {
    if (this.cur && this.cur.pts.length === 2) this.cur.pts.push(this.cur.pts[0] + 0.001, this.cur.pts[1]);
    this.cur = null;
    this.onChange();
  }

  // --- eraser: removes the parts of lines inside the circle, and texts it touches
  beginErase() { this.snapshot(); this.erasedAny = false; }
  erase(x, y, r) {
    const out = [];
    let changed = false;
    for (const it of this.items) {
      if (it.t === 'text') {
        const b = textBox(it);
        if (x + r > b.x0 && x - r < b.x1 && y + r > b.y0 && y - r < b.y1) { changed = true; continue; }
        out.push(it);
        continue;
      }
      const pts = densify(it.pts, Math.max(r / 3, 0.02));
      const rr = r + it.w / 2;
      let seg = [];
      const pieces = [];
      let cut = false;
      for (let i = 0; i < pts.length; i += 2) {
        if (Math.hypot(pts[i] - x, pts[i + 1] - y) <= rr) {
          cut = true;
          if (seg.length >= 4) pieces.push(seg);
          seg = [];
        } else seg.push(pts[i], pts[i + 1]);
      }
      if (seg.length >= 4) pieces.push(seg);
      if (!cut) { out.push(it); continue; }
      changed = true;
      for (const pc of pieces) out.push({ ...it, pts: pc });
    }
    if (changed) { this.items = out; this.erasedAny = true; this.onChange(); }
  }
  endErase() { if (!this.erasedAny) this.undoStack.pop(); }

  // --- text
  textAt(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.t !== 'text') continue;
      const b = textBox(it);
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return it;
    }
    return null;
  }
  addText(x, y, text, color, size) {
    if (!text.trim()) return;
    this.snapshot();
    this.items.push({ t: 'text', x, y, text, color, size });
    this.onChange();
  }
  editText(it, text) {
    this.snapshot();
    if (!text.trim()) this.items = this.items.filter(i => i !== it);
    else it.text = text;
    this.onChange();
  }

  draw(g, cam) {
    if (!this.visible) return;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const it of this.items) {
      if (it.t === 'line') {
        g.strokeStyle = it.color;
        g.lineWidth = Math.max(1, it.w * cam.s);
        g.beginPath();
        for (let i = 0; i < it.pts.length; i += 2) {
          const [sx, sy] = cam.toScreen(it.pts[i], it.pts[i + 1]);
          if (i === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy);
        }
        g.stroke();
      } else if (it.t === 'text') {
        const [sx, sy] = cam.toScreen(it.x, it.y);
        const fs = it.size * cam.s;
        if (fs < 2) continue;
        g.font = `600 ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
        g.textBaseline = 'top';
        g.lineWidth = Math.max(2, fs / 6);
        g.strokeStyle = 'rgba(0,0,0,.75)';
        const lines = String(it.text).split('\n');
        lines.forEach((ln, i) => {
          g.strokeText(ln, sx, sy + i * fs * 1.2);
          g.fillStyle = it.color;
          g.fillText(ln, sx, sy + i * fs * 1.2);
        });
      }
    }
    g.restore();
  }
}

// rough text box in world units (y grows upwards, text hangs down from its anchor)
let measureCtx = null;
function textBox(it) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `600 100px "IBM Plex Sans", system-ui, sans-serif`;
  const lines = String(it.text).split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  const ww = w / 100 * it.size, hh = lines.length * it.size * 1.2;
  return { x0: it.x, x1: it.x + ww, y0: it.y - hh, y1: it.y };
}

function densify(pts, step) {
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], y0 = pts[i - 1], x1 = pts[i], y1 = pts[i + 1];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n);
  }
  return out;
}
