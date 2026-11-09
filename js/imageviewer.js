// Sprite sheet viewer: shows the whole PNG of a sprite (every frame and direction),
// lets you pan / zoom, select a rectangle (free or snapped to frames) and copy or
// download either the selection or the whole image.

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let root = null;

// opts: { img (ImageBitmap|canvas), blob, title, path, frameW, frameH, states: [{name, dirs, frames}] , onToast }
export function openImageViewer(opts) {
  if (root) root.remove();
  root = document.createElement('div');
  root.className = 'iv';
  root.innerHTML = `
    <div class="ivbar">
      <div class="ivtitle"><b>${esc(opts.title || 'Sprite')}</b><span>${esc(opts.path || '')}</span></div>
      <div class="ivbtns">
        <span class="ivinfo" data-r="info"></span>
        <label class="ivchk"><input type="checkbox" data-r="grid" checked> Frame grid</label>
        <label class="ivchk"><input type="checkbox" data-r="snap" checked> Snap to frames</label>
        <button class="btn small" data-a="fit" title="Fit (F)">Fit</button>
        <button class="btn small" data-a="one" title="Actual size (1)">1:1</button>
        <button class="btn small" data-a="all" title="Select all (Ctrl+A)">Select all</button>
        <button class="btn small" data-a="copysel" title="Copy selection (Ctrl+C)">Copy selection</button>
        <button class="btn small" data-a="copyall" title="Copy the whole image">Copy all</button>
        <button class="btn small" data-a="dlsel">Download selection</button>
        <button class="btn small" data-a="dlall">Download all</button>
        <button class="btn small" data-a="close" title="Close (Esc)">Close</button>
      </div>
    </div>
    <div class="ivstage"><canvas></canvas></div>
    <div class="ivfoot"><span data-r="pos"></span><span class="ivhelp">drag to select · right-drag, middle-drag or Space+drag to move · scroll to zoom · double-click a frame to select it · Ctrl+C copies</span></div>`;
  document.body.appendChild(root);

  const img = opts.img;
  const IW = img.width, IH = img.height;
  const fw = opts.frameW || IW, fh = opts.frameH || IH;
  const cols = Math.max(1, Math.floor(IW / fw)), rows = Math.max(1, Math.floor(IH / fh));
  const hasGrid = (cols > 1 || rows > 1) && fw < IW + 1 && fh < IH + 1;
  // which state / direction a frame index belongs to (only for a whole-RSI sheet)
  const frameLabel = (() => {
    if (!opts.states) return null;
    const labels = [];
    const DIRS = ['S', 'N', 'E', 'W', 'SE', 'SW', 'NE', 'NW'];
    for (const st of opts.states) for (let d = 0; d < st.dirs; d++) for (let f = 0; f < st.frames[d]; f++)
      labels.push(`${st.name}${st.dirs > 1 ? ' · ' + DIRS[d] : ''}${st.frames[d] > 1 ? ' · frame ' + (f + 1) : ''}`);
    return labels;
  })();
  const gridChk = $('[data-r=grid]', root), snapChk = $('[data-r=snap]', root);
  if (!hasGrid) { gridChk.parentElement.hidden = true; snapChk.parentElement.hidden = true; snapChk.checked = false; }

  const stage = $('.ivstage', root), cv = $('canvas', stage), g = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const v = { x: 0, y: 0, s: 1 };     // image px at screen centre, screen px per image px
  let sel = null;                      // {x,y,w,h} in image px

  // source canvas so we can crop
  const src = document.createElement('canvas');
  src.width = IW; src.height = IH;
  src.getContext('2d').drawImage(img, 0, 0);

  const toImg = (sx, sy) => [(sx - W / 2) / v.s + v.x, (sy - H / 2) / v.s + v.y];
  const toScr = (ix, iy) => [(ix - v.x) * v.s + W / 2, (iy - v.y) * v.s + H / 2];

  function resize() {
    DPR = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    draw();
  }
  function fit() {
    v.x = IW / 2; v.y = IH / 2;
    v.s = Math.max(0.25, Math.min(64, Math.min((W - 60) / IW, (H - 60) / IH)));
    if (v.s > 1) v.s = Math.floor(v.s);
    draw();
  }
  function draw() {
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.fillStyle = '#0b0e14';
    g.fillRect(0, 0, W, H);
    const [x0, y0] = toScr(0, 0);
    // checkerboard behind the image (transparent pixels)
    g.save();
    g.beginPath(); g.rect(x0, y0, IW * v.s, IH * v.s); g.clip();
    const cs = 8;
    for (let y = Math.floor(y0 / cs) * cs; y < y0 + IH * v.s; y += cs)
      for (let x = Math.floor(x0 / cs) * cs; x < x0 + IW * v.s; x += cs) {
        g.fillStyle = ((x / cs + y / cs) & 1) ? '#1d2431' : '#151a24';
        g.fillRect(x, y, cs, cs);
      }
    g.restore();
    g.imageSmoothingEnabled = v.s < 1;
    g.drawImage(src, x0, y0, IW * v.s, IH * v.s);
    // pixel grid when very zoomed in
    if (v.s >= 12) {
      g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= IW; x++) { const sx = Math.round(x0 + x * v.s) + .5; g.moveTo(sx, y0); g.lineTo(sx, y0 + IH * v.s); }
      for (let y = 0; y <= IH; y++) { const sy = Math.round(y0 + y * v.s) + .5; g.moveTo(x0, sy); g.lineTo(x0 + IW * v.s, sy); }
      g.stroke();
    }
    // frame grid
    if (hasGrid && gridChk.checked) {
      g.strokeStyle = 'rgba(79,195,217,.55)'; g.lineWidth = 1;
      g.beginPath();
      for (let c = 0; c <= cols; c++) { const sx = Math.round(x0 + c * fw * v.s) + .5; g.moveTo(sx, y0); g.lineTo(sx, y0 + rows * fh * v.s); }
      for (let r = 0; r <= rows; r++) { const sy = Math.round(y0 + r * fh * v.s) + .5; g.moveTo(x0, sy); g.lineTo(x0 + cols * fw * v.s, sy); }
      g.stroke();
    }
    g.strokeStyle = '#2c3648'; g.lineWidth = 1;
    g.strokeRect(Math.round(x0) - .5, Math.round(y0) - .5, Math.round(IW * v.s) + 1, Math.round(IH * v.s) + 1);
    // selection
    if (sel && sel.w > 0 && sel.h > 0) {
      const [sx, sy] = toScr(sel.x, sel.y);
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.beginPath();
      g.rect(x0, y0, IW * v.s, IH * v.s);
      g.rect(sx, sy, sel.w * v.s, sel.h * v.s);
      g.fill('evenodd');
      g.strokeStyle = '#f2b84b'; g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.strokeRect(sx, sy, sel.w * v.s, sel.h * v.s);
      g.setLineDash([]);
    }
    const info = $('[data-r=info]', root);
    info.textContent = `${IW}×${IH}${hasGrid ? ` · ${cols}×${rows} frames of ${fw}×${fh}` : ''} · ${Math.round(v.s * 100)}%` +
      (sel ? ` · selection ${sel.w}×${sel.h} at ${sel.x},${sel.y}` : '');
  }

  function clampSel(a, b) {
    let x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    if (snapChk.checked && hasGrid) {
      x0 = Math.floor(x0 / fw) * fw; y0 = Math.floor(y0 / fh) * fh;
      x1 = Math.ceil((x1 + 0.0001) / fw) * fw; y1 = Math.ceil((y1 + 0.0001) / fh) * fh;
    } else {
      x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
      if (x1 === x0) x1++; if (y1 === y0) y1++;
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(IW, x1); y1 = Math.min(IH, y1);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---- input
  let drag = null, space = false;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const p = [e.offsetX, e.offsetY];
    if (e.button === 1 || e.button === 2 || space) {
      drag = { kind: 'pan', p, vx: v.x, vy: v.y };
      cv.style.cursor = 'grabbing';
    } else {
      drag = { kind: 'sel', a: toImg(...p) };
      sel = clampSel(drag.a, drag.a);
      draw();
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const [ix, iy] = toImg(e.offsetX, e.offsetY);
    const px = Math.floor(ix), py = Math.floor(iy);
    let t = (px >= 0 && py >= 0 && px < IW && py < IH) ? `x ${px}  y ${py}` : '';
    if (t && hasGrid) {
      const c = Math.floor(px / fw), r = Math.floor(py / fh), idx = r * cols + c;
      t += `   frame ${idx}` + (frameLabel && frameLabel[idx] ? ` (${frameLabel[idx]})` : '');
    }
    $('[data-r=pos]', root).textContent = t;
    if (!drag) return;
    if (drag.kind === 'pan') {
      v.x = drag.vx - (e.offsetX - drag.p[0]) / v.s;
      v.y = drag.vy - (e.offsetY - drag.p[1]) / v.s;
    } else {
      sel = clampSel(drag.a, [ix, iy]);
    }
    draw();
  });
  const up = () => { drag = null; cv.style.cursor = ''; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('dblclick', (e) => {
    if (!hasGrid) { sel = { x: 0, y: 0, w: IW, h: IH }; draw(); return; }
    const [ix, iy] = toImg(e.offsetX, e.offsetY);
    const c = Math.floor(ix / fw), r = Math.floor(iy / fh);
    if (c >= 0 && r >= 0 && c < cols && r < rows) { sel = { x: c * fw, y: r * fh, w: fw, h: fh }; draw(); }
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [ix, iy] = toImg(e.offsetX, e.offsetY);
    v.s = Math.max(0.1, Math.min(96, v.s * Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1))));
    const [ix2, iy2] = toImg(e.offsetX, e.offsetY);
    v.x += ix - ix2; v.y += iy - iy2;
    draw();
  }, { passive: false });

  const toast = opts.onToast || (() => {});
  const crop = (r) => {
    const c = document.createElement('canvas');
    c.width = r.w; c.height = r.h;
    c.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return new Promise(res => c.toBlob(res, 'image/png'));
  };
  const all = { x: 0, y: 0, w: IW, h: IH };
  async function copy(r) {
    try {
      const blob = (r === all && opts.blob && opts.blob.type === 'image/png') ? opts.blob : await crop(r);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(`Copied ${r.w}×${r.h}`);
    } catch (e) { toast('Copy failed: ' + e.message, true); }
  }
  async function save(r, suffix) {
    const blob = (r === all && opts.blob) ? opts.blob : await crop(r);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const base = String(opts.fileName || 'sprite.png').replace(/\.png$/i, '');
    a.download = base + (suffix || '') + '.png';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const needSel = () => { if (!sel) { toast('Drag on the image to select first (or double-click a frame)', true); return false; } return true; };

  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const act = a.dataset.a;
    if (act === 'fit') fit();
    else if (act === 'one') { v.s = 1; draw(); }
    else if (act === 'all') { sel = { ...all }; draw(); }
    else if (act === 'copysel') { if (needSel()) copy(sel); }
    else if (act === 'copyall') copy(all);
    else if (act === 'dlsel') { if (needSel()) save(sel, `_${sel.x}_${sel.y}_${sel.w}x${sel.h}`); }
    else if (act === 'dlall') save(all);
    else if (act === 'close') close();
  });
  gridChk.onchange = draw;

  const onKey = (e) => {
    if (e.key === ' ') { space = e.type === 'keydown'; e.preventDefault(); return; }
    if (e.type !== 'keydown') return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { if (sel) { sel = null; draw(); } else close(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'c') { e.preventDefault(); copy(sel || all); }
    else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); sel = { ...all }; draw(); }
    else if (k === 'f') fit();
    else if (k === '1') { v.s = 1; draw(); }
    else if (k === '+' || k === '=') { v.s = Math.min(96, v.s * 1.25); draw(); }
    else if (k === '-') { v.s = Math.max(0.1, v.s / 1.25); draw(); }
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('resize', resize);
  function close() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('resize', resize);
    root.remove();
    root = null;
  }
  resize();
  fit();
  // start with the frame that is on the map selected
  if (opts.select) { sel = { ...opts.select }; draw(); }
}
