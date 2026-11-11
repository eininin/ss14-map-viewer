// Browse maps: pick a server, then a category, then a sortable / filterable / searchable list.
// Also the server picker shown when a .yml is opened from disk.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATS = [
  { id: 'station', label: 'Stations', sub: 'stations, outposts, points of interest' },
  { id: 'shuttle', label: 'Shuttles', sub: 'ships, shuttles, shuttle events' },
  { id: 'dungeon', label: 'Dungeons', sub: 'ruins, salvage, lavaland, dungeon templates' },
  { id: 'dev', label: 'Dev', sub: 'test and development maps' },
  { id: 'misc', label: 'Misc', sub: 'Centcomm, non-stations, everything else' },
];
const SIZE_ORDER = { Micro: 0, Small: 1, Medium: 2, Large: 3 };
const kb = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB';
const num = (n) => Number(n || 0).toLocaleString('en-US');

let modal = null;
function shell(title) {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'bmodal';
    modal.innerHTML = `<div class="bbox"><div class="bhead"><div class="bcrumbs"></div><button class="btn" data-x>Close</button></div><div class="bbody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-x]')) close(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) { e.stopPropagation(); close(); } }, true);
  }
  modal.hidden = false;
  return modal;
}
function close() { if (modal) modal.hidden = true; }
function crumbs(parts) {
  const c = modal.querySelector('.bcrumbs');
  c.innerHTML = '';
  parts.forEach((p, i) => {
    if (i) c.insertAdjacentHTML('beforeend', '<span class="csep">›</span>');
    const b = document.createElement(p.go ? 'button' : 'span');
    b.className = 'crumb' + (p.go ? '' : ' cur');
    b.textContent = p.label;
    if (p.go) b.onclick = p.go;
    c.appendChild(b);
  });
}

// ---- step 1: servers (also used when opening a file)
export function pickServer({ forks, title, hint, current, counts, onPick }) {
  const m = shell();
  m.querySelector('.bbox').classList.add('compact');
  crumbs([{ label: title || 'Choose a server' }]);
  const body = m.querySelector('.bbody');
  body.innerHTML = `${hint ? `<p class="hint">${esc(hint)}</p>` : ''}<div class="tiles servers"></div>`;
  const box = body.querySelector('.tiles');
  for (const f of forks) {
    const b = document.createElement('button');
    b.className = 'tile server' + (f.id === current ? ' cur' : '');
    b.style.setProperty('--fc', f.color || '#f2b84b');
    b.innerHTML = `<span class="dot"></span><span class="tn">${esc(f.name)}</span>
      <span class="ts">${esc(f.repo)}${f.host === 'codeberg' ? ' · Codeberg' : ''}</span>
      ${counts && counts[f.id] != null ? `<span class="tc">${num(counts[f.id])} maps</span>` : ''}`;
    b.onclick = () => onPick(f);
    box.appendChild(b);
  }
}

// ---- the whole browser
export async function browse(o) {
  // o: { forks, current, loadMaps(fork) -> {maps, commit}, loadItems(fork) -> {items}, loadDb(fork) -> db, onOpen(fork, row), mapCounts }
  const state = { fork: null, cat: null };
  const toServers = () => {
    pickServer({ forks: o.forks, title: 'Servers', current: o.current, counts: o.mapCounts(),
      hint: 'Pick a server: its maps, its prototypes and its own sprites are used.',
      onPick: (f) => toCats(f) });
  };
  const toCats = async (f) => {
    state.fork = f;
    const m = shell();
    m.querySelector('.bbox').classList.add('compact');
    crumbs([{ label: 'Servers', go: toServers }, { label: f.name }]);
    const body = m.querySelector('.bbody');
    body.innerHTML = '<p class="hint">Loading the map list…</p>';
    let list;
    try { list = await o.loadMaps(f); } catch (e) { body.innerHTML = `<p class="hint">Could not load ${esc(f.name)}'s map list: ${esc(e.message)}</p>`; return; }
    const counts = {};
    for (const r of list.maps) counts[r.c] = (counts[r.c] || 0) + 1;
    body.innerHTML = `<p class="hint">${num(list.maps.length)} maps in ${esc(f.repo)}${list.commit ? ' @ ' + esc(String(list.commit).slice(0, 7)) : ''}.</p><div class="tiles cats"></div>`;
    const box = body.querySelector('.tiles');
    for (const c of [...CATS, { id: '*', label: 'All maps', sub: 'everything in one list' }]) {
      const n = c.id === '*' ? list.maps.length : (counts[c.id] || 0);
      const b = document.createElement('button');
      b.className = 'tile cat';
      b.style.setProperty('--fc', f.color || '#f2b84b');
      b.disabled = !n;
      b.innerHTML = `<span class="tn">${esc(c.label)}</span><span class="ts">${esc(c.sub)}</span><span class="tc">${num(n)}</span>`;
      b.onclick = () => toList(f, c, list);
      box.appendChild(b);
    }
  };
  const toList = (f, c, list) => {
    state.cat = c;
    const m = shell();
    m.querySelector('.bbox').classList.remove('compact');
    crumbs([{ label: 'Servers', go: toServers }, { label: f.name, go: () => toCats(f) }, { label: c.label }]);
    listView(m.querySelector('.bbody'), f, c, list, o);
  };
  if (o.startFork) {
    const f = o.forks.find(x => x.id === o.startFork);
    if (f) return toCats(f);
  }
  toServers();
}

// ---- step 3: the list
const SORTS = [
  { id: 'name', label: 'Name', key: (r) => r.n.toLowerCase(), dir: 1 },
  { id: 'official', label: 'Official (shipyard › size › price)', dir: 1, key: (r) => r.v ? [r.v.group || '~', SIZE_ORDER[r.v.size] ?? 9, r.v.price || 0, r.n.toLowerCase()] : ['~~', 9, 0, r.n.toLowerCase()] },
  { id: 'tiles', label: 'Floor area (tiles)', key: (r) => r.t, dir: -1 },
  { id: 'area', label: 'Bounding box (width × height)', key: (r) => r.w * r.h, dir: -1 },
  { id: 'width', label: 'Width', key: (r) => r.w, dir: -1 },
  { id: 'height', label: 'Height', key: (r) => r.h, dir: -1 },
  { id: 'ents', label: 'Entities', key: (r) => r.e, dir: -1 },
  { id: 'density', label: 'Entities per tile', key: (r) => r.t ? r.e / r.t : 0, dir: -1 },
  { id: 'bytes', label: 'File size', key: (r) => r.b, dir: -1 },
  { id: 'price', label: 'Price (shipyard)', key: (r) => r.v && r.v.price != null ? r.v.price : null, dir: -1 },
  { id: 'size', label: 'Ship size class', key: (r) => r.v ? (SIZE_ORDER[r.v.size] ?? null) : null, dir: 1 },
  { id: 'players', label: 'Players (station max)', key: (r) => r.s ? (r.s.max ?? r.s.min ?? null) : null, dir: -1 },
  { id: 'minplayers', label: 'Players (station min)', key: (r) => r.s ? (r.s.min ?? null) : null, dir: 1 },
  { id: 'grids', label: 'Number of grids', key: (r) => r.g, dir: -1 },
  { id: 'path', label: 'Folder / path', key: (r) => r.p.toLowerCase(), dir: 1 },
  { id: 'items', label: 'Count of searched items', key: (r) => r._count ?? null, dir: -1 },
];
const GROUPS = [
  { id: 'none', label: 'No grouping' },
  { id: 'group', label: 'Shipyard', get: (r) => r.v && r.v.group ? [r.v.group] : null },
  { id: 'class', label: 'Class (role)', get: (r) => r.v && r.v.class ? r.v.class : null },
  { id: 'size', label: 'Size class', get: (r) => r.v && r.v.size ? [r.v.size] : null },
  { id: 'engine', label: 'Engine', get: (r) => r.v && r.v.engine ? r.v.engine : null },
  { id: 'folder', label: 'Folder', get: (r) => [r.p.split('/').slice(1, -1).join('/') || 'Maps'] },
  { id: 'cat', label: 'Category', get: (r) => [r.c] },
];
const FILTERS = [
  { id: 'group', label: 'Shipyard', get: (r) => r.v && r.v.group ? [r.v.group] : [] },
  { id: 'class', label: 'Class', get: (r) => r.v && r.v.class ? r.v.class : [] },
  { id: 'size', label: 'Size', get: (r) => r.v && r.v.size ? [r.v.size] : [] },
  { id: 'engine', label: 'Engine', get: (r) => r.v && r.v.engine ? r.v.engine : [] },
];

function listView(body, f, c, list, o) {
  const all = list.maps.map((r, i) => ({ ...r, _i: i })).filter(r => c.id === '*' || r.c === c.id);
  const inList = new Set(all.map(r => r._i));
  const st = o.listState || (o.listState = {});
  const S = st[f.id + '|' + c.id] || (st[f.id + '|' + c.id] = { q: '', sort: all.some(r => r.v) ? 'official' : 'name', dir: 0, group: 'none', filters: {}, items: [] });
  // which filters have values here
  const present = FILTERS.map(fl => ({ ...fl, values: [...new Set(all.flatMap(fl.get))].sort((a, b) => (SIZE_ORDER[a] ?? 99) - (SIZE_ORDER[b] ?? 99) || String(a).localeCompare(String(b))) })).filter(fl => fl.values.length > 1);
  body.innerHTML = `
    <div class="bctl">
      <input class="search" data-r="q" placeholder="Search by name or path…" value="${esc(S.q)}">
      <div class="itemsearch">
        <div class="chips" data-r="chips"></div>
        <input class="search" data-r="item" placeholder="Contains item… (id or name)" autocomplete="off">
        <div class="sugg" data-r="sugg" hidden></div>
      </div>
      <label>Sort <select data-r="sort">${SORTS.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></label>
      <button class="btn small" data-r="dir" title="Reverse order">⇅</button>
      <label>Group <select data-r="group">${GROUPS.map(g => `<option value="${g.id}">${esc(g.label)}</option>`).join('')}</select></label>
      ${present.map(fl => `<label>${esc(fl.label)} <select data-f="${fl.id}"><option value="">any</option>${fl.values.map(v => `<option>${esc(v)}</option>`).join('')}</select></label>`).join('')}
    </div>
    <div class="bcount" data-r="count"></div>
    <div class="blist" data-r="list"></div>`;
  const $r = (k) => body.querySelector(`[data-r="${k}"]`);
  $r('sort').value = S.sort;
  $r('group').value = S.group;
  body.querySelectorAll('[data-f]').forEach(sel => { sel.value = S.filters[sel.dataset.f] || ''; });

  let items = null, db = null;
  const ensureItems = async () => {
    if (!items) { items = (await o.loadItems(f)).items || {}; }
    if (!db) { try { db = await o.loadDb(f); } catch (e) { db = { ent: {} }; } }
  };
  const itemName = (id) => (db && db.ent[id] && db.ent[id].n) || '';

  const render = () => {
    let rows = all;
    const q = S.q.trim().toLowerCase();
    if (q) rows = rows.filter(r => r.n.toLowerCase().includes(q) || r.p.toLowerCase().includes(q));
    for (const [k, v] of Object.entries(S.filters)) {
      if (!v) continue;
      const fl = FILTERS.find(x => x.id === k);
      rows = rows.filter(r => fl.get(r).includes(v));
    }
    // item search: maps containing every chosen item; count = smallest count among them
    for (const r of rows) r._count = undefined;
    if (S.items.length && items) {
      let allowed = null;
      for (const id of S.items) {
        const arr = items[id] || [];
        const m = new Map();
        for (let i = 0; i < arr.length; i += 2) m.set(arr[i], arr[i + 1]);
        allowed = allowed ? new Map([...allowed].filter(([k]) => m.has(k)).map(([k, v]) => [k, Math.min(v, m.get(k))])) : m;
      }
      rows = rows.filter(r => allowed.has(r._i));
      for (const r of rows) r._count = allowed.get(r._i);
    }
    const sort = SORTS.find(s => s.id === S.sort) || SORTS[0];
    const dir = S.dir || sort.dir;
    const cmp = (a, b) => {
      const ka = sort.key(a), kb2 = sort.key(b);
      if (ka == null && kb2 == null) return a.n.localeCompare(b.n);
      if (ka == null) return 1;
      if (kb2 == null) return -1;
      if (Array.isArray(ka)) { for (let i = 0; i < ka.length; i++) { if (ka[i] < kb2[i]) return -dir; if (ka[i] > kb2[i]) return dir; } return 0; }
      return (ka < kb2 ? -1 : ka > kb2 ? 1 : 0) * dir || a.n.localeCompare(b.n);
    };
    rows = rows.slice().sort(cmp);
    $r('count').textContent = `${rows.length} of ${all.length} maps` + (S.items.length ? ` containing ${S.items.join(' + ')}` : '');
    const listEl = $r('list');
    listEl.innerHTML = '';
    const grp = GROUPS.find(g => g.id === S.group);
    const sections = new Map();
    if (!grp || grp.id === 'none') sections.set('', rows);
    else for (const r of rows) for (const k of (grp.get(r) || ['(none)'])) { if (!sections.has(k)) sections.set(k, []); sections.get(k).push(r); }
    const keys = [...sections.keys()].sort((a, b) => (a === '(none)') - (b === '(none)') || (SIZE_ORDER[a] ?? 99) - (SIZE_ORDER[b] ?? 99) || a.localeCompare(b));
    for (const k of keys) {
      if (k) listEl.insertAdjacentHTML('beforeend', `<h3 class="bgrp">${esc(k)} <span class="badge">${sections.get(k).length}</span></h3>`);
      const box = document.createElement('div');
      box.className = 'brows';
      for (const r of sections.get(k)) box.appendChild(rowEl(r));
      listEl.appendChild(box);
    }
    if (!rows.length) listEl.innerHTML = '<p class="hint" style="padding:12px">No maps match.</p>';
  };
  const rowEl = (r) => {
    const b = document.createElement('button');
    b.className = 'brow';
    const badges = [];
    if (r.v) {
      if (r.v.size) badges.push(`<span class="bb size">${esc(r.v.size)}</span>`);
      if (r.v.group) badges.push(`<span class="bb grp">${esc(r.v.group)}</span>`);
      for (const x of r.v.class || []) badges.push(`<span class="bb cls">${esc(x)}</span>`);
      for (const x of r.v.engine || []) badges.push(`<span class="bb eng">${esc(x)}</span>`);
    }
    if (r.s && (r.s.min || r.s.max)) badges.push(`<span class="bb ply">${r.s.min || 0}${r.s.max ? '–' + r.s.max : '+'} players</span>`);
    b.title = (r.v && r.v.desc ? r.v.desc + '\n' : '') + r.p;
    b.innerHTML = `<div class="bn"><span class="nm">${esc(r.n)}</span>${r.v && r.v.price != null ? `<span class="pr">${num(r.v.price)} ¤</span>` : ''}${r._count != null ? `<span class="ic">× ${num(r._count)}</span>` : ''}</div>
      <div class="bp">${esc(r.p)}</div>
      ${badges.length ? `<div class="bbs">${badges.join('')}</div>` : ''}
      <div class="bst"><span>${num(r.t)} tiles</span><span>${r.w}×${r.h}</span><span>${num(r.e)} entities</span><span>${kb(r.b)}</span>${r.g > 1 ? `<span>${r.g} grids</span>` : ''}</div>`;
    b.onclick = () => { close(); o.onOpen(f, r, list); };
    return b;
  };
  const renderChips = () => {
    const ch = $r('chips');
    ch.innerHTML = '';
    for (const id of S.items) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `${esc(id)} <b title="Remove">✕</b>`;
      c.querySelector('b').onclick = () => { S.items = S.items.filter(x => x !== id); renderChips(); render(); };
      ch.appendChild(c);
    }
  };

  $r('q').oninput = (e) => { S.q = e.target.value; render(); };
  $r('sort').onchange = (e) => { S.sort = e.target.value; S.dir = 0; render(); };
  $r('dir').onclick = () => { const s = SORTS.find(x => x.id === S.sort); S.dir = -(S.dir || s.dir); render(); };
  $r('group').onchange = (e) => { S.group = e.target.value; render(); };
  body.querySelectorAll('[data-f]').forEach(sel => sel.onchange = () => { S.filters[sel.dataset.f] = sel.value; render(); });

  // item search with suggestions (prototypes that appear in this server's maps)
  const itemIn = $r('item'), sugg = $r('sugg');
  let picked = -1, cands = [];
  const showSugg = async () => {
    await ensureItems();
    const q = itemIn.value.trim().toLowerCase();
    if (!q) { sugg.hidden = true; return; }
    const res = [];
    for (const id in items) {
      const nm = itemName(id).toLowerCase();
      const li = id.toLowerCase();
      let score = -1;
      if (li === q || nm === q) score = 3; else if (li.startsWith(q) || nm.startsWith(q)) score = 2; else if (li.includes(q) || nm.includes(q)) score = 1;
      if (score < 0) continue;
      let here = 0;                      // maps in this list that have it
      const arr = items[id];
      for (let i = 0; i < arr.length; i += 2) if (inList.has(arr[i])) here++;
      res.push([score, here, id, arr.length / 2]);
    }
    res.sort((a, b) => (b[1] > 0) - (a[1] > 0) || b[0] - a[0] || b[1] - a[1] || a[2].localeCompare(b[2]));
    cands = res.slice(0, 30);
    picked = cands.length ? 0 : -1;
    sugg.innerHTML = cands.map(([, n, id, tot], i) => `<button data-i="${i}" class="${i === picked ? 'on' : ''}${n ? '' : ' none'}"><span class="si">${esc(id)}</span><span class="sn">${esc(itemName(id))}</span><span class="sc">${n ? n + ' here' : 'none here'}${tot !== n ? ' · ' + tot + ' on server' : ''}</span></button>`).join('') || '<p class="hint" style="padding:6px 8px;margin:0">Nothing on these maps matches.</p>';
    sugg.hidden = false;
    sugg.querySelectorAll('button').forEach(b => b.onmousedown = (e) => { e.preventDefault(); choose(+b.dataset.i); });
  };
  const choose = (i) => {
    const c2 = cands[i];
    if (!c2) return;
    if (!S.items.includes(c2[2])) S.items.push(c2[2]);
    itemIn.value = '';
    sugg.hidden = true;
    if (S.sort !== 'items') { S.sort = 'items'; S.dir = 0; $r('sort').value = 'items'; }
    renderChips();
    render();
  };
  itemIn.oninput = showSugg;
  itemIn.onfocus = () => { ensureItems().then(() => { if (itemIn.value) showSugg(); }); };
  itemIn.onblur = () => setTimeout(() => { sugg.hidden = true; }, 150);
  itemIn.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!cands.length) return;
      picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + cands.length) % cands.length;
      sugg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === picked));
    } else if (e.key === 'Enter') { e.preventDefault(); choose(picked); }
  };
  renderChips();
  if (S.items.length) ensureItems().then(render); else render();
  $r('q').focus();
}
