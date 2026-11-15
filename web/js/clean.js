// EXIF 제거: 사용자가 쓰던 "이미지 EXIF 제거 및 포맷 변환기" HTML을 앱 안으로 옮긴 것.
// 그림을 1px 줄였다가 원래 크기로 늘려 새로 그리고(픽셀에 숨은 정보까지 사라진다), JPG/PNG/WEBP로 다시 저장한다.
// 파일 이름은 15자리 무작위 숫자. 원본과 앱 안 기록은 건드리지 않고, 새 파일을 따로 정한 폴더에 저장한다.
import * as store from './store.js';
import { ZipWriter } from './zip.js';

export const CLEAN_FOLDER = 'Pictures/NAI_Clean';
let C = null;
const h = (...a) => C.h(...a);
const W = { files: [], results: [], busy: '', progress: '', pick: null, meta: null };
let seq = 0;

export function initClean(ctx) { C = ctx; }

// ---------------------------------------------------------------- 처리 (HTML과 같은 방식)
async function processImage(blob, format) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, hh = bmp.height;
  const shrink = document.createElement('canvas');
  shrink.width = Math.max(1, w - 1);
  shrink.height = Math.max(1, hh - 1);
  shrink.getContext('2d').drawImage(bmp, 0, 0, shrink.width, shrink.height);
  bmp.close?.();
  const out = document.createElement('canvas');
  out.width = w;
  out.height = hh;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(shrink, 0, 0, w, hh);
  const blobOut = await new Promise((r) => out.toBlob(r, `image/${format}`, 1.0));
  if (!blobOut) throw new Error('이미지를 만들지 못했어요');
  const name = `${Math.random().toString().slice(2, 17).padEnd(15, '0')}.${format === 'jpeg' ? 'jpg' : format}`;
  return { name, blob: blobOut, size: blobOut.size };
}

// ---------------------------------------------------------------- 메타데이터 분석 (HTML과 같은 키워드)
const KEYS = ['Comment', 'Description', 'Software', 'Source', 'Title', 'Artist', 'Copyright', 'Creation Time', 'Disclaimer', 'Warning', 'parameters', 'uc'];
const txt = (b) => new TextDecoder('utf-8', { fatal: false }).decode(b);
const clean = (s) => s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trim();
function parsePng(buf) {
  const found = {};
  const v = new DataView(buf);
  for (let o = 8; o + 8 <= v.byteLength;) {
    const len = v.getUint32(o);
    const type = txt(new Uint8Array(buf, o + 4, 4));
    const d = o + 8;
    if (d + len > v.byteLength) break;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const bytes = new Uint8Array(buf, d, len);
      const z = bytes.indexOf(0);
      if (z > 0) {
        const key = txt(bytes.subarray(0, z));
        const val = clean(txt(bytes.subarray(z + 1)));
        if (KEYS.some((k) => key.toLowerCase().includes(k.toLowerCase())) && val) found[key] = val;
      }
    }
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return found;
}
function parseJpeg(buf) {
  const found = {};
  const v = new DataView(buf);
  for (let o = 2; o < v.byteLength;) {
    if (v.getUint8(o) !== 0xFF) break;
    const m = v.getUint8(o + 1);
    o += 2;
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;
    if (m === 0xD9 || o + 2 > v.byteLength) break;
    const len = v.getUint16(o);
    const d = o + 2;
    if (d + len - 2 > v.byteLength) break;
    if (m === 0xFE) found.Comment = clean(txt(new Uint8Array(buf, d, len - 2)));
    else if (m === 0xE1) {
      const s = txt(new Uint8Array(buf, d, len - 2));
      if (s.startsWith('Exif\x00\x00')) {
        found['EXIF Block'] = 'EXIF 메타데이터 블록이 있어요.';
        if (s.includes('parameters')) found['AI Parameters'] = 'AI 생성 정보가 들어 있을 수 있어요.';
      }
    }
    o += len;
  }
  return found;
}
async function analyze(blob, name) {
  const buf = await blob.arrayBuffer();
  const s = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  const meta = s[0] === 137 && s[1] === 80 && s[2] === 78 && s[3] === 71 ? parsePng(buf) : s[0] === 0xFF && s[1] === 0xD8 ? parseJpeg(buf) : {};
  W.meta = { name, meta };
  renderOverlay();
}

// ---------------------------------------------------------------- 넣기
function addFiles(list) {
  for (const f of list) {
    if (!f || !String(f.type || '').startsWith('image/')) continue;
    W.files.push({ id: ++seq, name: f.name || `image_${seq}`, blob: f, size: f.size, url: URL.createObjectURL(f) });
  }
  C.renderView();
}
function removeFile(x) { URL.revokeObjectURL(x.url); W.files = W.files.filter((y) => y !== x); C.renderView(); }
function clearAll() {
  for (const x of [...W.files, ...W.results]) URL.revokeObjectURL(x.url);
  W.files = [];
  W.results = [];
  C.renderView();
}

async function run(format) {
  if (!W.files.length || W.busy) return;
  W.busy = format;
  for (const r of W.results) URL.revokeObjectURL(r.url);
  W.results = [];
  C.renderView();
  let fail = 0;
  for (let i = 0; i < W.files.length; i++) {
    const f = W.files[i];
    W.progress = `${i + 1} / ${W.files.length}`;
    const p = document.getElementById('clean-progress');
    if (p) p.textContent = W.progress;
    try {
      const r = await processImage(f.blob, format);
      W.results.push({ ...r, id: ++seq, origSize: f.size, url: URL.createObjectURL(r.blob) });
    } catch { fail++; }
  }
  W.busy = '';
  W.progress = '';
  C.renderView();
  C.toast(fail ? `변환 ${W.results.length}장, 실패 ${fail}장` : `${W.results.length}장 변환했어요`, fail ? 'bad' : 'ok');
}

async function saveAll() {
  if (!W.results.length) return;
  C.toast(`${W.results.length}장 저장하는 중…`);
  let ok = 0, where = '';
  for (const r of W.results) { const w = await C.saveAs(r.name, r.blob, CLEAN_FOLDER, true); if (w) { ok++; where = w; } }
  C.toast(ok ? `${ok}장 저장했어요: ${where}` : '저장하지 못했어요', ok ? 'ok' : 'bad');
}
async function saveZip() {
  if (!W.results.length) return;
  const parts = [];
  const zw = new ZipWriter(async (b) => { parts.push(b); });
  for (const r of W.results) await zw.add(r.name, new Uint8Array(await r.blob.arrayBuffer()));
  await zw.finish();
  await C.saveAs(`processed_images_${C.stamp()}.zip`, new Blob(parts, { type: 'application/zip' }), CLEAN_FOLDER);
}

const fmtBytes = (b) => {
  if (!b) return '0 B';
  const i = Math.min(2, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(2)} ${['B', 'KB', 'MB'][i]}`;
};

// ---------------------------------------------------------------- 화면
export function viewClean() {
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => { addFiles([...(e.target.files || [])]); e.target.value = ''; } });
  return h('div', { class: 'view clean-view' },
    h('section', { class: 'card' },
      h('b', { class: 'clean-title' }, 'EXIF 제거 & 랜덤 이름'),
      h('p', { class: 'muted small' }, '메타데이터(프롬프트·시드 등)를 지우고 파일 이름을 15자리 숫자로 바꿔 새로 저장해요. 원본과 앱 기록은 그대로 둬요.'),
      h('div', { class: 'row wrap gap6' },
        h('label', { class: 'btn primary' }, '📷 갤러리에서 넣기', fileIn),
        h('button', { class: 'btn', onclick: openPicker }, '🗂 상황 뽑기 기록에서 고르기')),
      h('p', { class: 'muted small' }, `저장 위치: 내 파일 › ${CLEAN_FOLDER}`)),
    W.files.length ? h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('b', {}, `대기 파일 (${W.files.length})`), C.confirmBtn('모두 지우기', '한 번 더', clearAll, 'btn small ghost danger')),
      h('div', { class: 'clean-grid g3' }, W.files.map((x) => h('div', { class: 'clean-cell' },
        h('img', { src: x.url, alt: x.name }),
        h('div', { class: 'clean-acts' },
          h('button', { class: 'mini', onclick: () => analyze(x.blob, x.name) }, '분석'),
          h('button', { class: 'mini danger', onclick: () => removeFile(x), 'aria-label': '빼기' }, '✕'))))),
      h('b', { class: 'small' }, '이 형식으로 변환'),
      h('div', { class: 'clean-formats' },
        [['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WEBP']].map(([f, l]) => h('button', { class: 'btn primary', disabled: Boolean(W.busy), onclick: () => run(f) }, W.busy === f ? '변환 중…' : l))),
      W.busy ? h('p', { class: 'muted small', id: 'clean-progress' }, W.progress) : h('p', { class: 'muted small' }, '변환하면 파일 이름이 15자리 무작위 숫자로 바뀌어요.')) : null,
    W.results.length ? h('section', { class: 'card' },
      h('div', { class: 'row between wrap gap6' }, h('b', {}, `변환 결과 (${W.results.length})`),
        h('div', { class: 'row gap6' },
          h('button', { class: 'btn small primary', onclick: saveAll }, '⬇ 전부 저장'),
          h('button', { class: 'btn small', onclick: saveZip }, 'ZIP으로 저장'))),
      h('div', { class: 'clean-grid g2' }, W.results.map((r) => h('div', { class: 'clean-cell result' },
        h('img', { src: r.url, alt: r.name }),
        h('div', { class: 'clean-info' }, h('span', { class: 'clean-name' }, r.name), h('span', { class: 'muted small' }, `${fmtBytes(r.origSize)} → ${fmtBytes(r.size)}`)),
        h('div', { class: 'clean-acts' },
          h('button', { class: 'mini accent', onclick: () => C.saveAs(r.name, r.blob, CLEAN_FOLDER) }, '저장'),
          h('button', { class: 'mini', onclick: () => analyze(r.blob, r.name) }, '확인')))))) : null);
}

// ---------------------------------------------------------------- 기록에서 고르기 · 메타 결과 창
async function openPicker() {
  const list = await C.sceneImages();
  W.pick = { list, sel: new Set(), limit: 90 };
  renderOverlay();
}
const thumbUrls = new Map();
async function thumbUrl(imgId) {
  if (thumbUrls.has(imgId)) return thumbUrls.get(imgId);
  const b = await store.imageGet(imgId);
  const u = b ? URL.createObjectURL(b) : '';
  thumbUrls.set(imgId, u);
  return u;
}
async function takePicked() {
  const ids = W.pick.list.filter((g) => W.pick.sel.has(g.id));
  const files = [];
  for (const g of ids) {
    const b = await store.imageGet(g.imgId);
    if (b) files.push(new File([b], `${g.id}.png`, { type: 'image/png' }));
  }
  W.pick = null;
  renderOverlay();
  addFiles(files);
  C.toast(`${files.length}장 넣었어요`, 'ok');
}

function renderOverlay() {
  let root = document.getElementById('clean-over');
  if (!root) { root = h('div', { id: 'clean-over', class: 'sheet' }); document.body.append(root); }
  root.innerHTML = '';
  const open = Boolean(W.pick || W.meta);
  root.hidden = !open;
  document.body.classList.toggle('sheet-open', open);
  if (!open) return;
  const panel = h('div', { class: 'sheet-panel', role: 'dialog' });
  root.append(h('div', { class: 'sheet-back', onclick: closeOverlay }), panel);
  if (W.meta) {
    const entries = Object.entries(W.meta.meta);
    panel.append(
      h('div', { class: 'row between' }, h('div', { class: 'sheet-title' }, '메타데이터 분석 결과'), h('button', { class: 'btn small ghost', onclick: closeOverlay }, '닫기')),
      h('p', { class: 'muted small' }, `파일: ${W.meta.name}`),
      ...(entries.length ? entries.map(([k, v]) => h('div', { class: 'note-block' }, h('span', { class: 'field-label' }, k), h('pre', { class: 'note-pre' }, v)))
        : [h('div', { class: 'clean-ok' }, h('b', {}, '분석 완료'), h('p', {}, '알려진 글자 메타데이터를 찾지 못했어요.'))]));
    return;
  }
  const P = W.pick;
  const grid = h('div', { class: 'thumb-pick' });
  for (const g of P.list.slice(0, P.limit)) {
    const img = h('img', { alt: '', loading: 'lazy' });
    thumbUrl(g.imgId).then((u) => { if (u) img.src = u; });
    const cell = h('button', { type: 'button', class: `thumb-cell${P.sel.has(g.id) ? ' on' : ''}`, onclick: () => { if (P.sel.has(g.id)) P.sel.delete(g.id); else P.sel.add(g.id); cell.classList.toggle('on'); count.textContent = `${P.sel.size}장 넣기`; } }, img, h('span', { class: 'thumb-check' }, '✓'));
    grid.append(cell);
  }
  const count = h('span', {}, `${P.sel.size}장 넣기`);
  panel.append(...[
    h('div', { class: 'row between' }, h('div', { class: 'sheet-title' }, '기록에서 고르기'), h('button', { class: 'btn small ghost', onclick: closeOverlay }, '닫기')),
    P.list.length ? h('div', { class: 'row gap6' },
      h('button', { class: 'btn small', onclick: () => { const all = P.list.slice(0, P.limit); if (P.sel.size >= all.length) P.sel.clear(); else all.forEach((g) => P.sel.add(g.id)); renderOverlay(); } }, '전체 선택'),
      h('button', { class: 'btn small primary grow', onclick: takePicked }, count)) : null,
    P.list.length ? grid : h('p', { class: 'empty' }, '상황 뽑기 기록에 그림이 없어요.'),
    P.list.length > P.limit ? h('button', { class: 'btn wide', onclick: () => { P.limit += 90; renderOverlay(); } }, `더 보기 (${P.list.length - P.limit}장 남음)`) : null].filter(Boolean));
}
function closeOverlay() { W.pick = null; W.meta = null; renderOverlay(); }

export function cleanBack() {
  if (W.pick || W.meta) { closeOverlay(); return true; }
  return false;
}
