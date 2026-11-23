// CG 묶음: 이어지는 일러스트(아티스트 CG)를 순서대로 모아 보는 곳.
// - 묶음(파일)을 여러 개 만들고, 갤러리나 상황 뽑기 기록에서 그림을 넣는다.
// - 보기: 한 줄에 한 장, 화면 너비에 원래 비율 그대로(픽시브 모바일 본문 그림처럼). 크기를 줄여 여러 장을 한눈에 볼 수도 있다.
// - 그림을 누르면 전체 화면(두 손가락 확대·옆으로 넘기기).
// - 순서 편집: ≡를 잡고 끌기, ▲▼, 번호로 이동, 사이에 그림·구분선 넣기, 그림 바꾸기, 빼기.
// - 저장: 순서대로 001, 002… 이름으로 폰에 저장하거나 ZIP 하나로.
// 그림 원본과 작은 썸네일은 IndexedDB images 저장소에 cg_<id>, cgt_<id>로, 묶음 목록은 kv 'cgSets'에 둔다.
import * as store from './store.js';
import { ZipWriter } from './zip.js';

export const CG_FOLDER = 'Pictures/NAI_CG';
let C = null;
const h = (...a) => C.h(...a);

const G = {
  sets: [],       // [{ id, name, created, updated, items: [{ id, kind: 'img'|'div', w, h, type, label }] }]
  open: null,     // 열어 둔 묶음 id
  edit: false,    // 순서 편집 화면
  zoom: 1,        // 보기 크기 (화면 너비 대비 0.25~1)
  viewer: null,   // { index } 전체 화면 보기
  sheet: null,    // { kind: 'item'|'set'|'pick'|'move'|'label', ... }
  rename: false,
  busy: '',
  insertAt: null, // 갤러리에서 고른 그림을 넣을 자리 (null = 맨 끝)
  replace: null,  // 그림 바꾸기 대상 item id
};

export function initCg(ctx) { C = ctx; }

export async function loadCg() {
  const [sets, zoom, open] = await Promise.all([store.kvGet('cgSets'), store.kvGet('cgZoom'), store.kvGet('cgOpen')]);
  G.sets = Array.isArray(sets) ? sets : [];
  G.open = G.sets.some((s) => s.id === open) ? open : null;
  const z = Number(zoom);
  G.zoom = z >= 0.25 && z <= 1 ? z : 1;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const cur = () => G.sets.find((s) => s.id === G.open) || null;
const images = (set) => set.items.filter((x) => x.kind === 'img');
const pad = (n, len = 3) => String(n).padStart(len, '0');
const safeName = (s) => String(s || 'CG').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 60) || 'CG';
const extOf = (type) => ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'png');

async function saveSets() {
  const s = cur();
  if (s) s.updated = Date.now();
  try { await store.kvSet('cgSets', G.sets); } catch (e) { C.toast(`저장하지 못했어요: ${e?.message || e}`, 'bad'); }
}

// ---------------------------------------------------------------- 그림 주소 (필요할 때만 만들고, 묶음을 닫으면 정리)
const fullUrls = new Map();
const thumbUrls = new Map();
async function urlOf(id, thumb = false) {
  const m = thumb ? thumbUrls : fullUrls;
  if (m.has(id)) return m.get(id);
  const p = store.imageGet(`${thumb ? 'cgt' : 'cg'}_${id}`).then((b) => (b ? URL.createObjectURL(b) : '')).catch(() => '');
  m.set(id, p);
  const u = await p;
  m.set(id, u);
  return u;
}
const thumbOrFull = (id) => urlOf(id, true).then((u) => u || urlOf(id));
async function releaseUrls() {
  for (const m of [fullUrls, thumbUrls]) {
    for (const v of m.values()) { const u = await v; if (u) URL.revokeObjectURL(u); }
    m.clear();
  }
}

// ---------------------------------------------------------------- 넣기 · 바꾸기 · 빼기
async function thumbOf(bmp) {
  const max = 240;
  const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * r));
  c.height = Math.max(1, Math.round(bmp.height * r));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}
async function storeImage(file, id) {
  const bmp = await createImageBitmap(file);
  const w = bmp.width, hh = bmp.height;
  const thumb = await thumbOf(bmp);
  bmp.close?.();
  await store.imagePut(`cg_${id}`, file);
  if (thumb) await store.imagePut(`cgt_${id}`, thumb);
  return { w, h: hh };
}

async function addFiles(list, at = null) {
  const set = cur();
  const files = [...list].filter((f) => f && String(f.type || '').startsWith('image/'));
  if (!set || !files.length) return;
  G.busy = `넣는 중 0 / ${files.length}`;
  C.renderView();
  const added = [];
  let fail = 0;
  for (let i = 0; i < files.length; i++) {
    G.busy = `넣는 중 ${i + 1} / ${files.length}`;
    const el = document.getElementById('cg-busy');
    if (el) el.textContent = G.busy;
    const id = uid();
    try {
      const dim = await storeImage(files[i], id);
      added.push({ id, kind: 'img', type: files[i].type || 'image/png', ...dim });
    } catch { fail++; }
  }
  const pos = at == null ? set.items.length : Math.max(0, Math.min(set.items.length, at));
  set.items.splice(pos, 0, ...added);
  G.busy = '';
  await saveSets();
  C.renderView();
  C.toast(fail ? `${added.length}장 넣음, ${fail}장 실패` : `${added.length}장 넣었어요`, fail ? 'bad' : 'ok');
}

async function replaceImage(itemId, file) {
  const set = cur();
  const it = set?.items.find((x) => x.id === itemId);
  if (!it || !file) return;
  const id = uid();
  try {
    const dim = await storeImage(file, id);
    await dropBlobs(it.id);
    Object.assign(it, { id, type: file.type || 'image/png', ...dim });
    await saveSets();
    C.renderView();
    C.toast('그림을 바꿨어요', 'ok');
  } catch (e) { C.toast(`바꾸지 못했어요: ${e?.message || e}`, 'bad'); }
}

async function dropBlobs(id) {
  for (const k of [`cg_${id}`, `cgt_${id}`]) await store.imageDelete(k).catch(() => {});
  for (const m of [fullUrls, thumbUrls]) {
    const v = m.get(id);
    if (v) { const u = await v; if (u) URL.revokeObjectURL(u); m.delete(id); }
  }
}

async function removeItem(itemId) {
  const set = cur();
  const it = set?.items.find((x) => x.id === itemId);
  if (!it) return;
  set.items = set.items.filter((x) => x !== it);
  if (it.kind === 'img') await dropBlobs(it.id);
  await saveSets();
  closeSheet();
  C.renderView();
}

function moveItem(from, to) {
  const set = cur();
  if (!set || from === to || from < 0 || from >= set.items.length) return;
  const [it] = set.items.splice(from, 1);
  set.items.splice(Math.max(0, Math.min(set.items.length, to)), 0, it);
  saveSets();
}

function addDivider(at = null, label = '') {
  const set = cur();
  if (!set) return;
  const pos = at == null ? set.items.length : at;
  const it = { id: uid(), kind: 'div', label };
  set.items.splice(pos, 0, it);
  saveSets();
  G.sheet = { kind: 'label', id: it.id, fresh: true };
  C.renderView();
  renderOverlay();
}

// ---------------------------------------------------------------- 묶음
function newSet(name) {
  const n = String(name || '').trim() || `CG ${G.sets.length + 1}`;
  const s = { id: uid(), name: n, created: Date.now(), updated: Date.now(), items: [] };
  G.sets.unshift(s);
  store.kvSet('cgSets', G.sets).catch(() => {});
  openSet(s.id);
}
function openSet(id) { G.open = id; G.edit = false; G.rename = false; store.kvSet('cgOpen', id).catch(() => {}); C.renderView(); window.scrollTo(0, 0); }
async function closeSet() {
  G.open = null; G.edit = false; G.rename = false; G.viewer = null;
  store.kvSet('cgOpen', null).catch(() => {});
  await releaseUrls();
  C.renderView();
  window.scrollTo(0, 0);
}
async function deleteSet() {
  const set = cur();
  if (!set) return;
  for (const it of set.items) if (it.kind === 'img') await dropBlobs(it.id);
  G.sets = G.sets.filter((s) => s !== set);
  await store.kvSet('cgSets', G.sets).catch(() => {});
  closeSheet();
  await closeSet();
  C.toast('묶음을 지웠어요');
}

// ---------------------------------------------------------------- 저장
async function exportSet(zip = false) {
  const set = cur();
  const imgs = set ? images(set) : [];
  if (!imgs.length) { C.toast('저장할 그림이 없어요', 'bad'); return; }
  closeSheet();
  const name = safeName(set.name);
  const width = Math.max(3, String(imgs.length).length);
  if (zip) {
    C.toast('ZIP 만드는 중…');
    const parts = [];
    const zw = new ZipWriter(async (b) => { parts.push(b); });
    for (let i = 0; i < imgs.length; i++) {
      const b = await store.imageGet(`cg_${imgs[i].id}`);
      if (b) await zw.add(`${pad(i + 1, width)}.${extOf(b.type || imgs[i].type)}`, new Uint8Array(await b.arrayBuffer()));
    }
    await zw.finish();
    await C.saveAs(`${name}.zip`, new Blob(parts, { type: 'application/zip' }), CG_FOLDER);
    return;
  }
  C.toast(`${imgs.length}장 순서대로 저장하는 중…`);
  let ok = 0, where = '';
  for (let i = 0; i < imgs.length; i++) {
    const b = await store.imageGet(`cg_${imgs[i].id}`);
    if (!b) continue;
    const w = await C.saveAs(`${pad(i + 1, width)}.${extOf(b.type || imgs[i].type)}`, b, `${CG_FOLDER}/${name}`, true);
    if (w) { ok++; where = w; }
  }
  C.toast(ok ? `${ok}장 저장했어요: ${where}` : '저장하지 못했어요', ok ? 'ok' : 'bad');
}

// ---------------------------------------------------------------- 화면
let fileIn = null;
function pickFromGallery(at = null, replaceId = null) {
  G.insertAt = at;
  G.replace = replaceId;
  if (!fileIn) {
    fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      if (G.replace) { const r = G.replace; G.replace = null; await replaceImage(r, files[0]); return; }
      await addFiles(files, G.insertAt);
    } });
    document.body.append(fileIn);
  }
  fileIn.multiple = !replaceId;
  fileIn.click();
}

export function viewCg() {
  const set = cur();
  if (!set) return viewSets();
  return G.edit ? viewEdit(set) : viewSet(set);
}

function viewSets() {
  const nameIn = h('input', { type: 'text', placeholder: '새 묶음 이름 (예: 비 오는 날 고백)', maxlength: 60,
    onkeydown: (e) => { if (e.key === 'Enter') newSet(nameIn.value); } });
  return h('div', { class: 'view cg-view' },
    h('section', { class: 'card' },
      h('b', { class: 'cg-title' }, '이어지는 일러스트를 순서대로'),
      h('p', { class: 'muted small' }, '묶음마다 그림을 넣고 순서를 정해요. 한 줄에 한 장씩 크게 보이고, 순서대로 001, 002… 이름으로 저장할 수 있어요.'),
      h('div', { class: 'row' }, nameIn, h('button', { class: 'btn primary', onclick: () => newSet(nameIn.value) }, '만들기'))),
    G.sets.length
      ? h('div', { class: 'cg-sets' }, G.sets.map((s) => {
        const first = images(s)[0];
        const img = h('img', { alt: '', loading: 'lazy' });
        if (first) thumbOrFull(first.id).then((u) => { if (u) img.src = u; });
        return h('button', { class: 'cg-set', onclick: () => openSet(s.id) },
          h('div', { class: 'cg-cover' }, first ? img : h('span', { class: 'cg-cover-empty' }, '비어 있음')),
          h('div', { class: 'cg-set-info' }, h('b', {}, s.name), h('span', { class: 'muted small' }, `${images(s).length}장 · ${C.when(s.updated || s.created)}`)));
      }))
      : h('p', { class: 'empty' }, '아직 묶음이 없어요. 위에서 이름을 적고 만들어 보세요.'));
}

function zoomBar() {
  const step = (d) => setZoom(Math.round((G.zoom + d) * 100) / 100);
  return h('div', { class: 'cg-zoom' },
    h('button', { class: 'mini', 'aria-label': '작게', disabled: G.zoom <= 0.25, onclick: () => step(-0.15) }, '−'),
    h('button', { class: 'mini cg-zoom-val', onclick: () => setZoom(1), 'aria-label': '원래 크기로' }, `${Math.round(G.zoom * 100)}%`),
    h('button', { class: 'mini', 'aria-label': '크게', disabled: G.zoom >= 1, onclick: () => step(0.15) }, '+'));
}
function setZoom(z) {
  G.zoom = Math.max(0.25, Math.min(1, z));
  const list = document.querySelector('.cg-list');
  if (list) {
    // 보던 곳(화면 가운데)이 그대로 보이게 스크롤을 맞춘다
    const top = list.getBoundingClientRect().top + window.scrollY;
    const rel = list.offsetHeight ? (window.scrollY + window.innerHeight / 2 - top) / list.offsetHeight : 0;
    list.style.setProperty('--cgw', `${G.zoom * 100}%`);
    window.scrollTo(0, top + rel * list.offsetHeight - window.innerHeight / 2);
  }
  const v = document.querySelector('.cg-zoom-val');
  if (v) v.textContent = `${Math.round(G.zoom * 100)}%`;
  document.querySelectorAll('.cg-zoom .mini').forEach((b, i) => { if (i === 0) b.disabled = G.zoom <= 0.25; if (i === 2) b.disabled = G.zoom >= 1; });
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(() => store.kvSet('cgZoom', G.zoom).catch(() => {}), 300);
}

function setHeader(set) {
  const imgsN = images(set).length;
  const title = G.rename
    ? (() => {
      const inp = h('input', { type: 'text', value: set.name, maxlength: 60, class: 'cg-rename',
        onkeydown: (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { G.rename = false; C.renderView(); } },
        onblur: () => { const v = inp.value.trim(); if (v) set.name = v; G.rename = false; saveSets(); C.renderView(); } });
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
      return inp;
    })()
    : h('button', { class: 'cg-name', onclick: () => { G.rename = true; C.renderView(); }, 'aria-label': '이름 바꾸기' }, set.name, h('span', { class: 'cg-pen' }, '✎'));
  return h('div', { class: `cg-head${G.edit ? ' sticky' : ''}` },
    h('div', { class: 'row' },
      h('button', { class: 'btn small ghost', onclick: closeSet }, '‹ 목록'),
      h('div', { class: 'cg-head-title' }, title),
      h('button', { class: 'icon-btn', onclick: () => { G.sheet = { kind: 'set' }; renderOverlay(); }, 'aria-label': '묶음 메뉴' }, '⋯')),
    h('div', { class: 'row cg-tools' },
      G.edit
        ? [h('button', { class: 'btn small primary', onclick: () => { G.edit = false; C.renderView(); } }, '✓ 편집 끝'),
          h('button', { class: 'btn small', onclick: () => pickFromGallery() }, '＋ 그림'),
          h('button', { class: 'btn small', onclick: () => addDivider() }, '＋ 구분선')]
        : [h('button', { class: 'btn small primary', onclick: () => pickFromGallery() }, '＋ 갤러리'),
          h('button', { class: 'btn small', onclick: openPicker }, '＋ 기록'),
          h('button', { class: 'btn small', disabled: !set.items.length, onclick: () => { G.edit = true; C.renderView(); window.scrollTo(0, 0); } }, '⇅ 순서 편집')]),
    G.busy ? h('p', { class: 'hint', id: 'cg-busy' }, G.busy) : h('p', { class: 'muted small' }, G.edit ? '≡를 잡고 위아래로 끌거나 ▲▼로 옮겨요. ⋯에서 번호로 이동·사이에 넣기·바꾸기·빼기.' : `${imgsN}장 · 그림을 누르면 전체 화면 · 두 손가락으로 오므리면 작게`));
}

// 보기: 한 줄에 한 장, 화면 너비 × 원래 비율
function viewSet(set) {
  const list = h('div', { class: 'cg-list', style: `--cgw:${G.zoom * 100}%` });
  const imgs = images(set);
  let no = 0;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      io.unobserve(img);
      urlOf(img.dataset.id).then((u) => { if (u) img.src = u; });
    }
  }, { rootMargin: '1600px 0px' });
  for (const it of set.items) {
    if (it.kind === 'div') { list.append(h('div', { class: 'cg-div' }, h('span', {}, it.label || '구분'))); continue; }
    no++;
    const i = no - 1;
    const img = h('img', { alt: `${no}번`, 'data-id': it.id, decoding: 'async' });
    io.observe(img);
    list.append(h('figure', { class: 'cg-page', style: `aspect-ratio:${it.w || 2}/${it.h || 3}`, onclick: () => openViewer(i) },
      img, h('span', { class: 'cg-no' }, `${no} / ${imgs.length}`)));
  }
  if (!set.items.length) {
    list.append(h('div', { class: 'cg-empty' },
      h('p', { class: 'empty' }, '아직 그림이 없어요.'),
      h('button', { class: 'btn primary', onclick: () => pickFromGallery() }, '📷 갤러리에서 넣기')));
  }
  pinch(list);
  return h('div', { class: 'view cg-view' }, setHeader(set), list, set.items.length ? h('div', { class: 'cg-float' }, zoomBar()) : null);
}

// 리스트를 두 손가락으로 오므리거나 벌려 크기 조절 (한 줄에 한 장은 그대로)
function pinch(el) {
  let d0 = 0, z0 = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { d0 = dist(e.touches); z0 = G.zoom; } }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !d0) return;
    e.preventDefault();
    setZoom(z0 * (dist(e.touches) / d0));
  }, { passive: false });
  el.addEventListener('touchend', (e) => { if (e.touches.length < 2) d0 = 0; });
}

// 순서 편집: 작은 썸네일 줄. ≡ 끌기 · ▲▼ · ⋯
function viewEdit(set) {
  const list = h('div', { class: 'cg-edit' });
  let no = 0;
  set.items.forEach((it, idx) => {
    const handle = h('button', { class: 'cg-handle', 'aria-label': '끌어서 옮기기', type: 'button' }, '≡');
    let row;
    if (it.kind === 'div') {
      row = h('div', { class: 'cg-row div', 'data-id': it.id }, handle,
        h('button', { class: 'cg-div-label', onclick: () => { G.sheet = { kind: 'label', id: it.id }; renderOverlay(); } }, `— ${it.label || '구분'} —`));
    } else {
      no++;
      const img = h('img', { alt: '' });
      thumbOrFull(it.id).then((u) => { if (u) img.src = u; });
      row = h('div', { class: 'cg-row', 'data-id': it.id }, handle,
        h('button', { class: 'cg-thumb', onclick: () => openViewer(no - 1), 'aria-label': '크게 보기' }, img),
        h('b', { class: 'cg-row-no' }, String(no)));
    }
    row.append(h('div', { class: 'cg-row-acts' },
      h('button', { class: 'mini', disabled: idx === 0, onclick: () => nudge(row, idx, -1), 'aria-label': '위로' }, '▲'),
      h('button', { class: 'mini', disabled: idx === set.items.length - 1, onclick: () => nudge(row, idx, 1), 'aria-label': '아래로' }, '▼'),
      h('button', { class: 'mini', onclick: () => { G.sheet = { kind: 'item', id: it.id }; renderOverlay(); }, 'aria-label': '더 보기' }, '⋯')));
    dragRow(handle, row, list);
    list.append(row);
  });
  return h('div', { class: 'view cg-view' }, setHeader(set), list);
}

// ▲▼: 옮긴 줄이 손가락 밑에 그대로 오도록 화면도 한 줄만큼 같이 움직인다 (연달아 누르기 쉽게)
function nudge(row, idx, d) {
  const sib = d < 0 ? row.previousElementSibling : row.nextElementSibling;
  const shift = sib ? sib.getBoundingClientRect().height + 6 : 0;
  moveItem(idx, idx + d);
  C.renderView();
  window.scrollBy(0, d * shift);
}

// ≡를 잡고 끌기: 손가락이 다른 줄의 가운데를 넘으면 자리를 바꾼다. 화면 위·아래 끝에서는 저절로 스크롤.
function dragRow(handle, row, list) {
  let active = false, lastY = 0, raf = 0;
  const step = () => {
    if (!active) return;
    const edge = 90;
    const dy = lastY < edge ? -14 : lastY > window.innerHeight - edge ? 14 : 0;
    if (dy) { window.scrollBy(0, dy); place(); }
    raf = requestAnimationFrame(step);
  };
  const place = () => {
    const rows = [...list.children].filter((r) => r !== row);
    let before = null;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (lastY < b.top + b.height / 2) { before = r; break; }
    }
    if (before) { if (row.nextSibling !== before) list.insertBefore(row, before); } else if (list.lastChild !== row) list.append(row);
  };
  // 줄을 DOM에서 옮기면 포인터 캡처가 풀리므로, 움직임은 window에서 받는다
  const move = (e) => { if (!active) return; lastY = e.clientY; place(); };
  const end = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    row.classList.remove('dragging');
    document.body.classList.remove('cg-dragging');
    const set = cur();
    const order = [...list.children].map((r) => r.dataset.id);
    const before = set.items.map((x) => x.id).join();
    set.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (set.items.map((x) => x.id).join() !== before) saveSets();
    C.renderView();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    active = true;
    lastY = e.clientY;
    row.classList.add('dragging');
    document.body.classList.add('cg-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    raf = requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------- 아래에서 올라오는 창 (줄 메뉴 · 묶음 메뉴 · 기록에서 고르기 · 번호 이동 · 구분선 이름)
async function openPicker() {
  const list = await C.sceneImages();
  G.sheet = { kind: 'pick', list, sel: [], limit: 90 };
  renderOverlay();
}
async function takePicked() {
  const P = G.sheet;
  const files = [];
  for (const gid of P.sel) {
    const g = P.list.find((x) => x.id === gid);
    const b = g ? await store.imageGet(g.imgId) : null;
    if (b) files.push(new File([b], `${g.id}.png`, { type: b.type || 'image/png' }));
  }
  closeSheet();
  await addFiles(files, P.at ?? null);
}
function closeSheet() { G.sheet = null; renderOverlay(); }

function renderOverlay() {
  let root = document.getElementById('cg-over');
  if (!root) { root = h('div', { id: 'cg-over', class: 'sheet' }); document.body.append(root); }
  root.innerHTML = '';
  const S = G.sheet;
  root.hidden = !S;
  document.body.classList.toggle('sheet-open', Boolean(S));
  if (!S) return;
  const panel = h('div', { class: 'sheet-panel', role: 'dialog' });
  root.append(h('div', { class: 'sheet-back', onclick: closeSheet }), panel);
  const set = cur();
  const head = (t) => h('div', { class: 'row between' }, h('div', { class: 'sheet-title' }, t), h('button', { class: 'btn small ghost', onclick: closeSheet }, '닫기'));
  const act = (label, fn, cls = 'btn wide') => h('button', { class: cls, onclick: fn }, label);

  if (S.kind === 'set' && set) {
    panel.append(head(set.name),
      act('✎ 이름 바꾸기', () => { closeSheet(); G.rename = true; C.renderView(); }),
      act(`⬇ 순서대로 저장 (${images(set).length}장, 001부터)`, () => exportSet(false), 'btn wide primary'),
      act('🗜 ZIP 하나로 저장', () => exportSet(true)),
      h('p', { class: 'muted small' }, `저장 위치: 내 파일 › ${CG_FOLDER}/${safeName(set.name)}`),
      C.confirmBtn('🗑 이 묶음 지우기', '한 번 더 누르면 지워요', deleteSet, 'btn wide ghost danger'));
    return;
  }
  if (S.kind === 'item' && set) {
    const idx = set.items.findIndex((x) => x.id === S.id);
    const it = set.items[idx];
    if (!it) { closeSheet(); return; }
    const no = it.kind === 'img' ? images(set).indexOf(it) + 1 : 0;
    const go = (to) => { moveItem(idx, to); closeSheet(); C.renderView(); };
    panel.append(head(it.kind === 'img' ? `${no}번 그림` : `구분선: ${it.label || '구분'}`),
      h('div', { class: 'cg-sheet-grid' },
        act('⤒ 맨 앞으로', () => go(0)),
        act('⤓ 맨 뒤로', () => go(set.items.length - 1)),
        act('# 번호로 이동', () => { G.sheet = { kind: 'move', id: it.id }; renderOverlay(); }),
        it.kind === 'img' ? act('🔍 크게 보기', () => { closeSheet(); openViewer(no - 1); }) : act('✎ 이름 바꾸기', () => { G.sheet = { kind: 'label', id: it.id }; renderOverlay(); }),
        act('＋ 아래에 그림 넣기', () => { closeSheet(); pickFromGallery(idx + 1); }),
        act('＋ 아래에 구분선', () => { closeSheet(); addDivider(idx + 1); }),
        act('＋ 위에 그림 넣기', () => { closeSheet(); pickFromGallery(idx); }),
        it.kind === 'img' ? act('↺ 그림 바꾸기', () => { closeSheet(); pickFromGallery(null, it.id); }) : null),
      C.confirmBtn(it.kind === 'img' ? '✕ 묶음에서 빼기' : '✕ 구분선 지우기', '한 번 더 누르면 빼요', () => removeItem(it.id), 'btn wide ghost danger'));
    return;
  }
  if (S.kind === 'move' && set) {
    const idx = set.items.findIndex((x) => x.id === S.id);
    const it = set.items[idx];
    if (!it) { closeSheet(); return; }
    // 번호는 그림 번호 기준(구분선은 세지 않음). 구분선을 옮길 때는 '그 번호 그림 앞'으로.
    const imgs = images(set);
    const inp = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: imgs.length, value: it.kind === 'img' ? imgs.indexOf(it) + 1 : 1 });
    const apply = () => {
      const n = Math.max(1, Math.min(imgs.length, Math.round(Number(inp.value) || 1)));
      const target = imgs[n - 1];
      const rest = set.items.filter((x) => x !== it);
      let pos = rest.indexOf(target);
      if (it.kind === 'img' && imgs.indexOf(it) < n - 1) pos += 1; // 뒤로 옮길 땐 그 그림 다음 자리
      rest.splice(Math.max(0, pos), 0, it);
      set.items = rest;
      saveSets();
      closeSheet();
      C.renderView();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    panel.append(head(it.kind === 'img' ? '몇 번으로 옮길까요?' : '몇 번 그림 앞에 둘까요?'),
      h('div', { class: 'row' }, inp, h('span', { class: 'muted' }, `/ ${imgs.length}`), h('button', { class: 'btn primary', onclick: apply }, '이동')));
    return;
  }
  if (S.kind === 'label' && set) {
    const it = set.items.find((x) => x.id === S.id);
    if (!it) { closeSheet(); return; }
    const inp = h('input', { type: 'text', value: it.label || '', maxlength: 40, placeholder: '예: 1장 · 만남 / 다음 날 아침' });
    const apply = () => { it.label = inp.value.trim(); saveSets(); closeSheet(); C.renderView(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    setTimeout(() => inp.focus(), 0);
    panel.append(head(S.fresh ? '구분선 이름' : '구분선 이름 바꾸기'), h('p', { class: 'muted small' }, '장면이 바뀌는 곳에 넣는 표시예요. 저장할 때 번호에는 들어가지 않아요.'),
      h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', onclick: apply }, '확인')));
    return;
  }
  if (S.kind === 'pick') {
    const P = S;
    const count = h('span', {}, `${P.sel.length}장 넣기`);
    const grid = h('div', { class: 'thumb-pick' });
    for (const g of P.list.slice(0, P.limit)) {
      const img = h('img', { alt: '', loading: 'lazy' });
      store.imageGet(g.imgId).then((b) => { if (b) { img.src = URL.createObjectURL(b); img.onload = () => URL.revokeObjectURL(img.src); } });
      const badge = h('span', { class: 'thumb-check' }, P.sel.includes(g.id) ? String(P.sel.indexOf(g.id) + 1) : '✓');
      const cell = h('button', { type: 'button', class: `thumb-cell${P.sel.includes(g.id) ? ' on' : ''}`, onclick: () => {
        const i = P.sel.indexOf(g.id);
        if (i >= 0) P.sel.splice(i, 1); else P.sel.push(g.id);
        // 고른 순서대로 번호가 붙고, 그 순서로 들어간다
        grid.querySelectorAll('.thumb-cell').forEach((c) => {
          const k = P.sel.indexOf(c.dataset.id);
          c.classList.toggle('on', k >= 0);
          c.querySelector('.thumb-check').textContent = k >= 0 ? String(k + 1) : '✓';
        });
        count.textContent = `${P.sel.length}장 넣기`;
      } }, img, badge);
      cell.dataset.id = g.id;
      grid.append(cell);
    }
    panel.append(head('상황 뽑기 기록에서 고르기'),
      h('p', { class: 'muted small' }, '누른 순서대로 번호가 붙고, 그 순서로 묶음 끝에 들어가요.'),
      P.list.length ? h('button', { class: 'btn primary wide', onclick: takePicked }, count) : null,
      P.list.length ? grid : h('p', { class: 'empty' }, '상황 뽑기 기록에 그림이 없어요.'),
      P.list.length > P.limit ? h('button', { class: 'btn wide', onclick: () => { P.limit += 90; renderOverlay(); } }, `더 보기 (${P.list.length - P.limit}장 남음)`) : null);
  }
}

// ---------------------------------------------------------------- 전체 화면 보기 (두 손가락 확대 · 두 번 탭 확대 · 옆으로 넘기기)
function openViewer(index) {
  G.viewer = { index };
  renderViewer();
}
function closeViewer() {
  G.viewer = null;
  renderViewer();
}
function renderViewer() {
  let root = document.getElementById('cg-viewer');
  if (!root) { root = h('div', { id: 'cg-viewer', class: 'viewer cg-viewer', role: 'dialog', 'aria-label': 'CG 크게 보기' }); document.body.append(root); }
  root.innerHTML = '';
  const set = cur();
  const open = Boolean(G.viewer && set);
  root.hidden = !open;
  document.body.classList.toggle('viewer-open', open);
  if (!open) return;
  const imgs = images(set);
  if (!imgs.length) { closeViewer(); return; }
  const V = G.viewer;
  V.index = Math.max(0, Math.min(imgs.length - 1, V.index));
  const it = imgs[V.index];
  // 이 그림이 속한 구분선 이름
  let section = '';
  for (const x of set.items) { if (x.kind === 'div') section = x.label || ''; if (x === it) break; }
  const img = h('img', { class: 'cg-vimg', alt: `${V.index + 1}번`, draggable: 'false' });
  urlOf(it.id).then((u) => { if (u) img.src = u; });
  for (const k of [V.index - 1, V.index + 1]) if (imgs[k]) urlOf(imgs[k].id); // 옆 그림 미리 읽기
  const stage = h('div', { class: 'cg-stage' }, img);
  root.append(
    h('div', { class: 'viewer-top' },
      h('div', { class: 'viewer-head' }, h('span', { class: 'viewer-count' }, `${V.index + 1} / ${imgs.length}`), section ? h('span', { class: 'viewer-pos' }, section) : null),
      h('button', { class: 'btn close', onclick: closeViewer }, '닫기')),
    stage,
    h('div', { class: 'cg-vbar' },
      h('button', { class: 'btn nav-arrow', disabled: V.index === 0, onclick: () => step(-1), 'aria-label': '앞 그림' }, '‹'),
      h('span', { class: 'muted small' }, '두 번 탭·두 손가락으로 확대'),
      h('button', { class: 'btn nav-arrow', disabled: V.index === imgs.length - 1, onclick: () => step(1), 'aria-label': '다음 그림' }, '›')));
  gestures(stage, img);
}
function step(d) {
  const set = cur();
  if (!G.viewer || !set) return;
  const n = images(set).length;
  const next = G.viewer.index + d;
  if (next < 0 || next >= n) return;
  G.viewer.index = next;
  renderViewer();
}
export function cgKey(e) {
  if (!G.viewer) return false;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else return false;
  return true;
}

function gestures(stage, img) {
  const T = { s: 1, x: 0, y: 0 };
  const apply = (anim = false) => {
    img.style.transition = anim ? 'transform .18s ease-out' : 'none';
    img.style.transform = `translate(${T.x}px, ${T.y}px) scale(${T.s})`;
  };
  const clampPan = () => {
    const r = stage.getBoundingClientRect();
    const mx = (r.width * (T.s - 1)) / 2, my = (r.height * (T.s - 1)) / 2;
    T.x = Math.max(-mx, Math.min(mx, T.x));
    T.y = Math.max(-my, Math.min(my, T.y));
  };
  const zoomAt = (s, cx, cy) => {
    const r = stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    const k = s / T.s;
    T.x = px - (px - T.x) * k;
    T.y = py - (py - T.y) * k;
    T.s = s;
    if (T.s <= 1.01) { T.s = 1; T.x = 0; T.y = 0; }
    clampPan();
  };
  let g = null, lastTap = 0, lastTapX = 0, lastTapY = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [mx, my] = mid(e.touches);
      g = { kind: 'pinch', d0: dist(e.touches), s0: T.s, x0: T.x, y0: T.y, mx, my };
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      g = { kind: T.s > 1 ? 'pan' : 'swipe', sx: t.clientX, sy: t.clientY, x0: T.x, y0: T.y, moved: false };
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!g) return;
    e.preventDefault();
    if (g.kind === 'pinch' && e.touches.length === 2) {
      const s = Math.max(1, Math.min(5, g.s0 * (dist(e.touches) / g.d0)));
      const [mx, my] = mid(e.touches);
      T.s = g.s0; T.x = g.x0 + (mx - g.mx); T.y = g.y0 + (my - g.my);
      zoomAt(s, mx, my);
      apply();
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - g.sx, dy = t.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
      if (g.kind === 'pan') { T.x = g.x0 + dx; T.y = g.y0 + dy; clampPan(); apply(); }
      else if (g.kind === 'swipe') { T.x = dx; apply(); }
    }
  }, { passive: false });
  stage.addEventListener('touchend', (e) => {
    if (!g) return;
    const k = g;
    if (e.touches.length) { // 두 손가락 중 하나만 뗐을 때: 남은 손가락으로 계속 끌기
      if (k.kind === 'pinch' && e.touches.length === 1) { const t = e.touches[0]; g = { kind: T.s > 1 ? 'pan' : 'swipe', sx: t.clientX, sy: t.clientY, x0: T.x, y0: T.y, moved: true }; }
      return;
    }
    g = null;
    if (k.kind === 'swipe') {
      const dx = T.x;
      if (dx < -70) { step(1); return; }
      if (dx > 70) { step(-1); return; }
      T.x = 0; apply(true);
    }
    if (!k.moved && k.kind !== 'pinch') {
      const now = Date.now();
      const t = e.changedTouches[0];
      if (now - lastTap < 300 && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 30) {
        if (T.s > 1) { T.s = 1; T.x = 0; T.y = 0; } else zoomAt(2.5, t.clientX, t.clientY);
        apply(true);
        lastTap = 0;
      } else { lastTap = now; lastTapX = t.clientX; lastTapY = t.clientY; }
    }
  });
  // 컴퓨터(미리보기)용: 휠 확대 · 두 번 클릭
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.max(1, Math.min(5, T.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), e.clientX, e.clientY); apply(); }, { passive: false });
  stage.addEventListener('dblclick', (e) => { if (T.s > 1) { T.s = 1; T.x = 0; T.y = 0; } else zoomAt(2.5, e.clientX, e.clientY); apply(true); });
}

// ---------------------------------------------------------------- 뒤로 가기
export function cgBack() {
  if (G.viewer) { closeViewer(); return true; }
  if (G.sheet) { closeSheet(); return true; }
  if (G.rename) { G.rename = false; C.renderView(); return true; }
  if (G.edit) { G.edit = false; C.renderView(); return true; }
  if (G.open) { closeSet(); return true; }
  return false;
}
