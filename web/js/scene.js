// 상황 뽑기: novelai.net 이미지 화면(V5 모바일)을 따라 만든 생성 화면.
// 위에는 결과가 쌓이고(최신이 맨 위), 아래에는 끌어올리는 시트에 프롬프트·UC·캐릭터·설정과 생성 버튼이 있다.
// 생성 중에도 버튼을 누르면 그 순간의 설정이 그대로 예약된다(×N으로 여러 장). 폰에서는 생성 서비스가 백그라운드에서 받는다.
import {
  SCENE_MODELS, SCENE_SIZES, SCENE_SAMPLERS, NOISE_SCHEDULES, QUALITY_PRESETS, UC_PRESETS, MAX_SEED, RETRY_DELAYS, AUTH_STATUSES,
  isV5Full, sceneEffective, sceneSize, buildScenePayload, generatePayload, randomSeed, isFreeForOpus, IMAGES_PER_PERCENT,
} from './nai.js';
import * as store from './store.js';

let C = null;  // app.js가 넘겨주는 공용 도구 (h, toast, native, Gen, Filesystem, …)
const h = (...a) => C.h(...a);

// ---------------------------------------------------------------- state
const DEF = {
  prompt: '', negative: '', chars: [], posMode: 'ai',
  model: 'nai-diffusion-5-full', effort: 'high', size: 'normal-portrait', width: 832, height: 1216,
  steps: 28, scale: 5, rescale: 0, sampler: 'k_euler_ancestral', noise: 'karras', seed: '',
  quality: 'none', ucPreset: 'none', count: 1, tab: 'prompt', grid: 1, hgrid: 3, stab: 'gen', open: true, autocomplete: false,
};
const SC = { ...DEF };
let G = [];  // 생성 기록 (최신이 앞)
let NOTES = [];  // 노트: 직접 쓰는 상황 노트(kind 'scene')·캐릭터 노트(kind 'char')
const UI = { snap: 1, h: 0, limit: 20, viewer: null, settingsOpen: false, queueKeys: [], current: null, lp: null };
const urls = new Map();
const LQ = { items: [], busy: false };  // 브라우저 미리보기용 대기열 (폰에서는 생성 서비스가 맡는다)

export const isSceneKey = (k) => /^s\d+_\d+$/.test(String(k));
const UI_KEYS = ['tab', 'grid', 'hgrid', 'stab', 'open', 'count', 'autocomplete'];
const snapshot = () => { const o = JSON.parse(JSON.stringify(SC)); for (const k of UI_KEYS) delete o[k]; return o; };

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.kvSet('scene', JSON.parse(JSON.stringify(SC))).catch(() => {}), 300);
}
const putGen = (g) => store.genPut(g).catch(() => {});

export function initScene(ctx) { C = ctx; }

export async function loadScene() {
  const saved = await store.kvGet('scene');
  if (saved && typeof saved === 'object') Object.assign(SC, DEF, saved);
  else Object.assign(SC, DEF, C.defaults());
  if (!Array.isArray(SC.chars)) SC.chars = [];
  G = await store.genList();
  const notes = await store.kvGet('notes');
  NOTES = Array.isArray(notes) ? notes.filter((x) => x && (x.kind === 'scene' || x.kind === 'char')) : [];
  if (!C.native) for (const g of G) if (g.status === 'wait' || g.status === 'run') { g.status = 'stop'; putGen(g); }
}

// ---------------------------------------------------------------- prompt editor: 가중치 색 표시 + 태그 자동완성
// NAI 문법: {} ×1.05, [] ÷1.05, `1.2::태그 ::` 숫자 가중치(`::`로 닫음, 열린 괄호도 닫힘).
const NUM = /(-?\d*\.?\d+)::/y;
function weightRuns(text) {
  const out = [];
  let num = null, curly = 0, square = 0, buf = '', bw = null;
  const flush = () => { if (buf) out.push([buf, bw]); buf = ''; };
  const put = (s, w) => { if (w !== bw) { flush(); bw = w; } buf += s; };
  for (let i = 0; i < text.length;) {
    const prev = text[i - 1];
    NUM.lastIndex = i;
    const m = (!prev || !/[\w.]/.test(prev)) ? NUM.exec(text) : null;
    // 숫자 앞머리(1.2::)는 그 가중치와 같은 색으로 칠한다. 1.0::처럼 그대로면 기호(초록)로.
    if (m) { num = parseFloat(m[1]); const w = num * 1.05 ** (curly - square); put(m[0], Math.abs(w - 1) < 0.001 ? 'syn' : Math.round(w * 1000) / 1000); i += m[0].length; continue; }
    if (text.startsWith('::', i)) { put('::', 'syn'); num = null; curly = 0; square = 0; i += 2; continue; }
    const ch = text[i];
    if (ch === '{') { curly++; put(ch, 'syn'); } else if (ch === '}') { curly = Math.max(0, curly - 1); put(ch, 'syn'); } else if (ch === '[') { square++; put(ch, 'syn'); } else if (ch === ']') { square = Math.max(0, square - 1); put(ch, 'syn'); } else {
      const w = (num ?? 1) * 1.05 ** (curly - square);
      put(ch, Math.round(w * 1000) / 1000);
    }
    i++;
  }
  flush();
  return out;
}
// novelai.net과 같은 형광펜: 올린 곳 빨강, 내린 곳 파랑, 닫는 :: 와 괄호·1.0:: 은 초록. 글자색은 그대로.
function weightClass(w) {
  if (w === 'syn') return 'syn';
  if (Math.abs(w - 1) < 0.001) return '';
  return w > 1 ? 'hi' : 'lo';
}
function paint(pre, text) {
  pre.textContent = '';
  for (const [s, w] of weightRuns(text)) {
    const cls = weightClass(w);
    if (!cls) pre.append(document.createTextNode(s));
    else { const sp = document.createElement('span'); sp.className = `w-${cls}`; sp.textContent = s; pre.append(sp); }
  }
  pre.append(document.createTextNode('​\n'));
}

// 태그 사전 (단부루 CSV에서 만든 web/data/tags.json): [태그, 한글명, 게시물, 종류, 검색키워드, 바꿔쓸태그]
let TAGS = null, tagsLoading = null;
function loadTags() {
  if (TAGS) return Promise.resolve(TAGS);
  if (!tagsLoading) tagsLoading = fetch('data/tags.json').then((r) => r.json()).then((t) => { TAGS = t; return t; }).catch(() => { tagsLoading = null; return null; });
  return tagsLoading;
}
const KIND_LABEL = { 1: '작가', 3: '작품', 4: '캐릭터', 5: '메타', 6: '바뀐 태그' };
function searchTags(q) {
  if (!TAGS) return [];
  const query = q.toLowerCase().replace(/_/g, ' ').trim();
  if (!query) return [];
  const hangul = /[가-힣ㄱ-ㅎ]/.test(query);
  const res = [], seen = new Set();
  const take = (t) => { if (!seen.has(t[0])) { seen.add(t[0]); res.push(t); } };
  if (!hangul) {
    const art = query.startsWith('artist:');
    for (const t of TAGS) { if (t[0].startsWith(query) || (!art && t[3] === 1 && t[0].startsWith(`artist:${query}`))) take(t); if (res.length >= 8) return res; }
    for (const t of TAGS) { if (t[0].includes(` ${query}`) || t[0].includes(`(${query}`)) take(t); if (res.length >= 8) return res; }
  }
  for (const t of TAGS) { if ((t[1] && t[1].includes(query)) || (t[4] && t[4].includes(query))) take(t); if (res.length >= 8) return res; }
  if (!hangul) for (const t of TAGS) { if (t[0].includes(query)) take(t); if (res.length >= 8) return res; }
  return res;
}
const DELIM = /[,\n|{}[\]]/;
function tokenAt(text, caret) {
  let start = caret;
  while (start > 0 && !DELIM.test(text[start - 1]) && text.slice(start - 2, start) !== '::') start--;
  let core = text.slice(start, caret);
  const lead = core.match(/^\s*/)[0];
  start += lead.length;
  core = core.slice(lead.length);
  let end = caret;
  while (end < text.length && !DELIM.test(text[end]) && !text.startsWith('::', end)) end++;
  return { start, end, core };
}
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || ''));

// get/set: 값 읽기·쓰기. 높이는 내용에 맞춰 늘어난다(시트가 스크롤된다).
function editor({ get, set, placeholder, id }) {
  const pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'ed-ta', id, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder, value: get() });
  const sug = h('div', { class: 'ed-sug', hidden: true });
  let timer;
  // 입력칸이 직접 스크롤된다(길면 칸 안에서 스크롤). 글자를 끌어 선택할 때 폰이 칸 안을 알아서 내려 준다.
  // 뒤의 색칠한 글자는 입력칸 스크롤 위치를 따라간다.
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; pre.scrollTop = ta.scrollTop; };
  const refresh = () => { paint(pre, ta.value); fit(); };
  ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; });
  const suggest = () => {
    clearTimeout(timer);
    if (!SC.autocomplete) { sug.hidden = true; return; }
    timer = setTimeout(async () => {
      const { core } = tokenAt(ta.value, ta.selectionStart);
      const q = core.trim();
      if (!q || (q.length < 2 && !/[가-힣]/.test(q)) || /^-?\d*\.?\d*$/.test(q)) { sug.hidden = true; return; }
      await loadTags();
      const list = searchTags(q);
      sug.innerHTML = '';
      sug.hidden = !list.length;
      for (const t of list) {
        const [tag, kor, count, kind, , alt] = t;
        sug.append(h('button', { type: 'button', class: `sug k${kind}`, onmousedown: (e) => e.preventDefault(), onclick: () => pick(alt || tag), title: [kor, KIND_LABEL[kind]].filter(Boolean).join(' · ') },
          h('span', { class: 'sug-tag' }, alt ? `${tag} → ${alt}` : tag),
          kor ? h('span', { class: 'sug-kor' }, kor) : null,
          h('span', { class: 'sug-n' }, fmtCount(count))));
      }
    }, 120);
  };
  const pick = (tag) => {
    const { start, end } = tokenAt(ta.value, ta.selectionStart);
    const after = ta.value.slice(end);
    const close = /^\s*(::|[,}\]])/.test(after) ? '' : ', ';
    ta.value = ta.value.slice(0, start) + tag + close + after.replace(/^[ \t]+/, close ? '' : '');
    const pos = start + tag.length + close.length;
    ta.setSelectionRange(pos, pos);
    sug.hidden = true;
    set(ta.value);
    refresh();
    ta.focus();
  };
  ta.addEventListener('input', () => { set(ta.value); refresh(); suggest(); });
  ta.addEventListener('click', suggest);
  ta.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 150));
  refresh();
  const wrap = h('div', { class: 'ed' }, h('div', { class: 'ed-box' }, pre, ta), sug);
  requestAnimationFrame(fit);
  wrap.refresh = () => { ta.value = get(); refresh(); };
  return wrap;
}

// ---------------------------------------------------------------- 결과 화면 (위쪽)
async function urlFor(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await store.imageGet(id);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}
const doneList = () => G.filter((g) => g.status === 'done' && g.imgId);
const STATUS = { wait: '예약됨', run: '생성 중', stop: '중단', fail: '실패' };
const cardEls = new Map();

function itemCard(g) {
  const el = h('div', { class: `sc-item s-${g.status}`, style: `aspect-ratio:${g.width}/${g.height}` });
  fillCard(el, g);
  cardEls.set(g.id, el);
  return el;
}
function fillCard(el, g) {
  el.className = `sc-item s-${g.status}`;
  el.innerHTML = '';
  if (g.status === 'done' && g.imgId) {
    const img = h('img', { alt: `생성 ${g.seed}`, loading: 'lazy' });
    urlFor(g.imgId).then((u) => { if (u) img.src = u; });
    const pic = h('button', { type: 'button', class: 'sc-pic', onclick: () => { if (lpFired) { lpFired = false; return; } openViewer(g.id); } }, img);
    longPress(pic, () => showLp(el, g));
    el.append(pic);
    if (UI.lp === g.id) el.append(lpMenu(g));
    return;
  }
  const qi = UI.queueKeys.indexOf(g.id);
  const label = g.status === 'wait' && qi >= 0 ? `예약 ${qi + 1 - (UI.current && UI.queueKeys[0] === UI.current ? 1 : 0)}번째` : STATUS[g.status] || g.status;
  el.append(h('div', { class: 'sc-ph' },
    g.status === 'run' ? h('div', { class: 'sc-spin' }) : null,
    h('b', {}, label),
    h('span', { class: 'sc-ph-sub' }, `시드 ${g.seed} · ${g.width}×${g.height}`),
    g.error ? h('span', { class: 'sc-err' }, g.error) : null,
    h('div', { class: 'row gap6' },
      g.status === 'wait' ? h('button', { type: 'button', class: 'btn small', onclick: () => removeReserved([g]) }, '예약 빼기') : null,
      g.status === 'fail' || g.status === 'stop' ? h('button', { type: 'button', class: 'btn small', onclick: () => retry(g) }, '다시 생성') : null,
      g.status === 'fail' || g.status === 'stop' ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => deleteGen(g) }, '지우기') : null)));
}
function updateCard(g) {
  const el = cardEls.get(g.id);
  if (el && el.isConnected) fillCard(el, g);
  refreshBatchHead(g.created);
}

// 예약 묶음: 한 번 누를 때 만든 그림들 (created가 같다). 최신 묶음이 앞.
function batches() {
  const map = new Map();
  for (const g of G) { if (!map.has(g.created)) map.set(g.created, []); map.get(g.created).push(g); }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([ts, items]) => ({ ts, items: items.sort((x, y) => (x.no || 0) - (y.no || 0)) }));
}
const pendingBatch = (b) => b.items.some((g) => g.status === 'wait' || g.status === 'run');
// 생성 탭: 아직 덜 끝난 묶음 전부 + 가장 최근 묶음. 다 끝난 예전 묶음은 기록 탭에서만 보인다.
const genBatches = () => batches().filter((b, i) => i === 0 || pendingBatch(b));
const scopeIds = () => (SC.stab === 'hist' ? batches() : genBatches()).flatMap((b) => b.items).filter((g) => g.status === 'done' && g.imgId).map((g) => g.id);
const fileName = (g) => `NAI_${C.stamp(g.created)}_${(g.no || 0) + 1}_${g.seed}.png`;

async function saveBatch(items) {
  const done = items.filter((g) => g.status === 'done' && g.imgId);
  if (!done.length) { C.toast('저장할 그림이 없어요', 'bad'); return; }
  C.toast(`${done.length}장 저장하는 중…`);
  let ok = 0, where = '';
  for (const g of done) {
    const b = await store.imageGet(g.imgId).catch(() => null);
    if (!b) continue;
    const r = await C.saveBlobQuiet(fileName(g), b);
    if (r) { ok++; where = r; }
  }
  C.toast(ok ? `${ok}장 저장했어요${where ? `: ${where}` : ''}` : '저장하지 못했어요', ok ? 'ok' : 'bad');
}

function batchHead(b) {
  const n = b.items.length;
  const done = b.items.filter((g) => g.status === 'done').length;
  const wait = b.items.filter((g) => g.status === 'wait');
  const run = b.items.some((g) => g.status === 'run');
  const fail = b.items.filter((g) => g.status === 'fail' || g.status === 'stop').length;
  return h('div', { class: 'sc-batch-head', id: `bh-${b.ts}` },
      h('div', { class: 'sc-batch-title' },
        h('b', {}, `${n}장 예약`),
        h('span', { class: 'muted small' }, `${C.when(b.ts)} · 완료 ${done}/${n}${run ? ' · 생성 중' : ''}${fail ? ` · 실패 ${fail}` : ''}`)),
      h('div', { class: 'row gap6' },
        wait.length ? C.confirmBtn('예약 빼기', '한 번 더', () => removeReserved(wait), 'btn small ghost') : null,
        h('button', { type: 'button', class: 'btn small primary', disabled: !done, onclick: () => saveBatch(b.items) }, `전부 저장 (${done})`)));
}
function batchBlock(b, grid) {
  return h('section', { class: 'sc-batch' }, batchHead(b), h('div', { class: `sc-list g${grid}` }, b.items.map(itemCard)));
}
function refreshBatchHead(ts) {
  const old = document.getElementById(`bh-${ts}`);
  if (!old) return;
  const b = batches().find((x) => x.ts === ts);
  if (b) old.replaceWith(batchHead(b));
}

export function viewScene() {
  cardEls.clear();
  const hist = SC.stab === 'hist';
  const grid = hist ? SC.hgrid : SC.grid;
  const all = batches();
  const shown = hist ? all.slice(0, UI.limit) : genBatches();
  const clear = C.confirmBtn('예약 모두 빼기', '한 번 더', () => removeReserved(G.filter((g) => g.status === 'wait')));
  clear.id = 'sc-clear';
  clear.hidden = !G.some((g) => g.status === 'wait');
  const tabs = h('div', { class: 'sc-tabs sc-vtabs' },
    h('button', { type: 'button', class: `sc-tab${!hist ? ' on' : ''}`, onclick: () => { SC.stab = 'gen'; UI.lp = null; save(); C.renderView(); window.scrollTo(0, 0); } }, '생성'),
    h('button', { type: 'button', class: `sc-tab${hist ? ' on' : ''}`, onclick: () => { SC.stab = 'hist'; UI.lp = null; save(); C.renderView(); window.scrollTo(0, 0); } }, '기록 ', h('span', { id: 'sc-hist-n' }, String(doneList().length))));
  const root = h('div', { class: 'view sc-view' },
    tabs,
    h('div', { class: 'sc-toolbar' },
      h('button', { type: 'button', class: 'btn small', onclick: openNotes }, '📒 노트'),
      h('span', { class: 'muted small', id: 'sc-count' }),
      h('div', { class: 'seg' }, [1, 2, 3].map((n) => h('button', { type: 'button', class: `seg-b${grid === n ? ' on' : ''}`, onclick: () => { if (hist) SC.hgrid = n; else SC.grid = n; save(); C.renderView(); } }, n === 1 ? '크게' : `${n}열`))),
      clear),
    shown.length ? shown.map((b) => batchBlock(b, grid))
      : h('div', { class: 'sc-empty' },
        h('div', { class: 'sc-empty-mark' }, '✦'),
        h('p', {}, hist ? '아직 기록이 없어요.' : '아래 시트에 프롬프트를 넣고 생성을 누르세요.'),
        hist ? null : h('p', { class: 'muted small' }, '생성 중에 또 누르면 그때 설정 그대로 예약돼요. 앱을 꺼도 백그라운드에서 받아요.')),
    !hist && all.length > shown.length ? h('button', { class: 'btn wide ghost', onclick: () => { SC.stab = 'hist'; save(); C.renderView(); window.scrollTo(0, 0); } }, `이전 그림은 기록 탭에 있어요 (${all.length - shown.length}묶음)`) : null,
    hist && all.length > UI.limit ? h('button', { class: 'btn wide', onclick: () => { UI.limit += 20; C.renderView(); } }, `더 보기 (${all.length - UI.limit}묶음 남음)`) : null);
  return root;
}

// 길게 누르기: 그림 위에 저장·공유 버튼을 띄운다 (짧게 누르면 크게 보기)
let lpFired = false;
function longPress(el, fn) {
  let t = null, x0 = 0, y0 = 0;
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; lpFired = false; cancel(); t = setTimeout(() => { t = null; lpFired = true; navigator.vibrate?.(20); fn(); setTimeout(() => { lpFired = false; }, 900); }, 450); }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 10) cancel(); }, { passive: true });
  el.addEventListener('touchend', (e) => { cancel(); if (lpFired && e.cancelable) e.preventDefault(); });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!lpFired) { lpFired = false; fn(); } });
}
function showLp(el, g) {
  const prev = UI.lp && cardEls.get(UI.lp);
  UI.lp = g.id;
  if (prev && prev !== el) prev.querySelector('.sc-lp')?.remove();
  el.querySelector('.sc-lp')?.remove();
  el.append(lpMenu(g));
}
function hideLp() {
  const el = UI.lp && cardEls.get(UI.lp);
  el?.querySelector('.sc-lp')?.remove();
  UI.lp = null;
}
function lpMenu(g) {
  const go = (fn) => async (e) => { e.stopPropagation(); const b = await store.imageGet(g.imgId); hideLp(); if (b) fn(fileName(g), b); };
  return h('div', { class: 'sc-lp', onclick: (e) => { if (e.target === e.currentTarget) hideLp(); } },
    h('button', { type: 'button', class: 'btn primary', onclick: go((n, b) => C.saveBlob(n, b)) }, '⬇ 저장'),
    h('button', { type: 'button', class: 'btn', onclick: go((n, b) => C.shareBlob(n, b)) }, '공유'),
    h('button', { type: 'button', class: 'btn ghost', onclick: (e) => { e.stopPropagation(); hideLp(); } }, '닫기'));
}

// ---------------------------------------------------------------- 생성·예약
function validate() {
  if (!C.apiKey() && !globalThis.__mock) return '설정(⚙)에서 NovelAI API 키를 먼저 넣어 주세요.';
  if (!String(SC.prompt || '').trim()) return '프롬프트가 비어 있어요.';
  const [w, hh] = sceneSize(SC);
  if (w % 64 || hh % 64 || w < 64 || hh < 64) return '가로·세로는 64의 배수여야 해요.';
  return '';
}

async function reserve() {
  const bad = validate();
  if (bad) { C.toast(bad, 'bad'); return; }
  const n = Math.max(1, Math.min(50, Math.round(SC.count) || 1));
  const params = snapshot();
  const ts = Date.now();
  const fixed = String(SC.seed).trim() === '' ? null : Number(SC.seed);
  const e = sceneEffective(params);
  const recs = [];
  for (let i = 0; i < n; i++) {
    const seed = fixed === null || !Number.isFinite(fixed) ? randomSeed() : (Math.floor(fixed) + i) % MAX_SEED;
    recs.push({ id: `s${ts}_${i}`, no: i, created: ts, status: 'wait', seed, params, width: e.width, height: e.height, error: '', imgId: null });
  }
  let jobs;
  try { jobs = recs.map((g) => ({ key: g.id, body: JSON.stringify(buildScenePayload(g.params, g.seed)) })); } catch (err) { C.toast(err.message, 'bad'); return; }
  G.unshift(...recs.slice().reverse());
  for (const g of recs) putGen(g);
  UI.limit = Math.max(UI.limit, 40);
  if (C.native) {
    UI.queueKeys = [...UI.queueKeys, ...recs.map((g) => g.id)];
    try {
      C.askNotifications();
      C.pending(1);
      await C.Gen.genEnqueue({ apiKey: C.apiKey(), jobs });
    } catch (err) {
      for (const g of recs) { g.status = 'stop'; g.error = String(err?.message || err); putGen(g); }
      C.toast(`예약하지 못했어요: ${err?.message || err}`, 'bad');
    } finally { C.pending(-1); }
    C.sync();
  } else {
    for (const g of recs) LQ.items.push(g);
    if (!LQ.busy) processLocal();
  }
  C.toast(n > 1 ? `${n}장 예약했어요` : (busyCount() > 1 ? '예약했어요' : '생성을 시작해요'), 'ok');
  C.renderView();
  renderGoBar();
}

function busyCount() { return G.filter((g) => g.status === 'wait' || g.status === 'run').length; }

async function removeReserved(list) {
  const keys = list.filter((g) => g.status === 'wait').map((g) => g.id);
  if (!keys.length) return;
  let removed = keys;
  if (C.native) {
    try {
      const res = await C.Gen.genRemove({ keys });
      if (res && Array.isArray(res.keys)) removed = res.keys;
    } catch (err) { C.toast(`예약을 빼지 못했어요: ${err?.message || err}`, 'bad'); return; }
  } else LQ.items = LQ.items.filter((g) => !keys.includes(g.id));
  const set = new Set(removed);
  for (const g of G.filter((x) => set.has(x.id))) store.genDelete(g.id).catch(() => {});
  G = G.filter((g) => !set.has(g.id));
  UI.queueKeys = UI.queueKeys.filter((k) => !set.has(k));
  C.toast(`예약 ${set.size}장을 뺐어요`, 'ok');
  C.renderView();
  renderGoBar();
  C.sync();
}

async function retry(g) {
  const bad = validate();
  if (bad) { C.toast(bad, 'bad'); return; }
  g.status = 'wait';
  g.error = '';
  putGen(g);
  if (C.native) {
    try {
      C.pending(1);
      UI.queueKeys = [...UI.queueKeys, g.id];
      await C.Gen.genEnqueue({ apiKey: C.apiKey(), jobs: [{ key: g.id, body: JSON.stringify(buildScenePayload(g.params, g.seed)) }] });
    } catch (err) { g.status = 'stop'; g.error = String(err?.message || err); putGen(g); } finally { C.pending(-1); }
    C.sync();
  } else { LQ.items.push(g); if (!LQ.busy) processLocal(); }
  updateCard(g);
  renderGoBar();
}

async function deleteGen(g) {
  G = G.filter((x) => x !== g);
  await store.genDelete(g.id).catch(() => {});
  if (g.imgId) { await store.imageDelete(g.imgId).catch(() => {}); const u = urls.get(g.imgId); if (u) URL.revokeObjectURL(u); urls.delete(g.imgId); }
  C.renderView();
  renderGoBar();
}

// 브라우저 미리보기: 화면 안에서 차례로 생성 (폰에서는 쓰이지 않는다)
async function processLocal() {
  LQ.busy = true;
  while (LQ.items.length) {
    const g = LQ.items.shift();
    if (!G.includes(g) || g.status !== 'wait') continue;
    g.status = 'run';
    updateCard(g);
    renderGoBar();
    let stop = false;
    for (const delay of [...RETRY_DELAYS, null]) {
      try {
        const png = await generatePayload(buildScenePayload(g.params, g.seed), C.apiKey());
        await store.imagePut(g.id, new Blob([png], { type: 'image/png' }));
        g.imgId = g.id;
        g.status = 'done';
        g.error = '';
        break;
      } catch (err) {
        const st = err?.status;
        if (AUTH_STATUSES.includes(st) || st === 400 || st === 402 || delay === null) { g.status = 'fail'; g.error = err.message; stop = AUTH_STATUSES.includes(st) || st === 402; break; }
        g.error = `${err.message} · ${delay}초 뒤 다시`;
        updateCard(g);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
    putGen(g);
    updateCard(g);
    afterItem(g);
    renderGoBar();
    if (stop) { for (const x of LQ.items) { x.status = 'stop'; putGen(x); updateCard(x); } LQ.items = []; C.toast(g.error, 'bad'); }
  }
  LQ.busy = false;
  C.refreshSub();
  renderGoBar();
}

// ---------------------------------------------------------------- 생성 서비스(폰)와 맞추기
// 묶음이 다 끝났는데 최신 묶음이 아니면 생성 탭에서 빠진다 → 다시 그린다
function afterItem(g) {
  if (SC.stab !== 'gen' || C.app() !== 'scene') return;
  const bs = batches();
  const b = bs.find((x) => x.ts === g.created);
  if (b && b !== bs[0] && !pendingBatch(b)) C.renderView();
}

// 끝난 결과 하나를 가져온다. 상황 뽑기 키면 true (기록이 지워졌어도 받은 것으로 친다).
export async function takeResult(r) {
  if (!isSceneKey(r.key)) return false;
  const g = G.find((x) => x.id === r.key);
  if (!g) return true;
  if (r.status === 'done') {
    try {
      const f = await C.Filesystem.readFile({ path: `gen/img/${r.key}.png`, directory: 'DATA' });
      await store.imagePut(g.id, new Blob([C.fromBase64(f.data)], { type: 'image/png' }));
      g.imgId = g.id;
      g.status = 'done';
      g.error = '';
    } catch (e) {
      g.status = 'fail';
      g.error = `그림 파일을 읽지 못했어요: ${e?.message || e}`;
    }
  } else {
    g.status = r.status === 'fail' ? 'fail' : 'stop';
    g.error = r.error || '';
  }
  await store.genPut(g).catch(() => {});
  updateCard(g);
  afterItem(g);
  return true;
}

// 대기열 상태: current = 지금 생성 중인 키, queueKeys = 남은 대기열(순서대로)
export function syncStatus({ current, queueKeys, busy, pending }) {
  const keys = (queueKeys || []).filter(isSceneKey);
  const changed = keys.join() !== UI.queueKeys.join() || current !== UI.current;
  UI.queueKeys = keys;
  UI.current = current;
  const queued = new Set(keys);
  for (const g of G) {
    if (g.status !== 'wait' && g.status !== 'run') continue;
    let next = g.status;
    if (g.id === current) next = 'run';
    else if (queued.has(g.id)) next = 'wait';
    else if (!busy && !pending) next = 'stop';
    if (next !== g.status) { g.status = next; if (next === 'stop') { putGen(g); afterItem(g); } updateCard(g); }
    else if (changed && g.status === 'wait') updateCard(g);
  }
  renderGoBar();
}

// ---------------------------------------------------------------- 뷰어
const viewerList = () => (UI.viewer?.ids || []).map((id) => G.find((g) => g.id === id)).filter((g) => g && g.status === 'done' && g.imgId);
function openViewer(id) {
  hideLp();
  const ids = scopeIds();
  const i = ids.indexOf(id);
  if (i < 0) return;
  UI.viewer = { i, zoom: false, ids };
  renderViewer();
}
function closeViewer() { UI.viewer = null; renderViewer(); }
function stepViewer(d) {
  const list = viewerList();
  if (!UI.viewer || !list.length) return;
  UI.viewer.i = (UI.viewer.i + d + list.length) % list.length;
  UI.viewer.zoom = false;
  renderViewer();
}
const shortModel = (m) => (SCENE_MODELS.find(([k]) => k === m)?.[1] || m).replace('NAI Diffusion ', '');

function applyParams(p, withSeed, seed) {
  const keep = { tab: SC.tab, grid: SC.grid, hgrid: SC.hgrid, stab: SC.stab, open: SC.open, count: SC.count, autocomplete: SC.autocomplete };
  Object.assign(SC, DEF, JSON.parse(JSON.stringify(p)), keep);
  SC.seed = withSeed ? String(seed) : '';
  save();
  renderSheet(true);
}

function renderViewer() {
  const root = document.getElementById('sviewer');
  root.innerHTML = '';
  root.hidden = !UI.viewer;
  document.body.classList.toggle('viewer-open', Boolean(UI.viewer));
  if (!UI.viewer) return;
  const list = viewerList();
  const g = list[UI.viewer.i];
  if (!g) { closeViewer(); return; }
  const img = h('img', { class: `sv-img${UI.viewer.zoom ? ' zoom' : ''}`, alt: `시드 ${g.seed}` });
  urlFor(g.imgId).then((u) => { if (u) img.src = u; });
  let sx = 0, sy = 0;
  const stage = h('div', { class: `sv-stage${UI.viewer.zoom ? ' zoom' : ''}`,
    ontouchstart: (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; },
    ontouchend: (e) => { if (UI.viewer.zoom) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepViewer(dx < 0 ? 1 : -1); },
    onclick: () => { UI.viewer.zoom = !UI.viewer.zoom; renderViewer(); } }, img);
  const p = g.params;
  const e = sceneEffective(p);
  const name = fileName(g);
  root.append(
    h('div', { class: 'sv-top' },
      h('div', { class: 'sv-head' }, h('b', { class: 'sv-count' }, `${UI.viewer.i + 1} / ${list.length}`),
        h('span', { class: 'sv-sub' }, `${shortModel(p.model)}${e.medium ? ' Medium' : ''} · ${g.width}×${g.height} · ${e.steps}스텝 · ${C.when(g.created)}`)),
      h('button', { class: 'btn ghost close', onclick: closeViewer }, '닫기')),
    stage,
    h('button', { type: 'button', class: 'sv-seed', onclick: () => C.copy(String(g.seed), '시드') }, `Seed ${g.seed}`, h('span', { class: 'muted small' }, ' 눌러서 복사')),
    h('div', { class: 'sv-actions' },
      h('button', { class: 'btn', onclick: () => { SC.seed = String(g.seed); save(); renderSheet(true); C.toast('시드를 넣었어요', 'ok'); } }, '시드 적용'),
      h('button', { class: 'btn', onclick: () => { applyParams(p, false); C.toast('설정을 불러왔어요 (시드 빼고)', 'ok'); } }, '설정 쓰기'),
      h('button', { class: 'btn', onclick: () => { applyParams(p, true, g.seed); C.toast('설정과 시드를 불러왔어요', 'ok'); } }, '설정+시드'),
      C.confirmBtn('지우기', '한 번 더', () => { deleteGen(g); UI.viewer.ids = UI.viewer.ids.filter((x) => x !== g.id); const n = viewerList().length; if (!n) closeViewer(); else { UI.viewer.i = Math.min(UI.viewer.i, n - 1); renderViewer(); } }, 'btn danger')),
    h('div', { class: 'sv-bar' },
      h('button', { class: 'btn nav-arrow', onclick: () => stepViewer(-1), 'aria-label': '이전' }, '‹'),
      h('button', { class: 'btn', onclick: async () => { const b = await store.imageGet(g.imgId); if (b) C.saveBlob(name, b); } }, '저장'),
      h('button', { class: 'btn', onclick: async () => { const b = await store.imageGet(g.imgId); if (b) C.shareBlob(name, b); } }, '공유'),
      h('button', { class: 'btn nav-arrow', onclick: () => stepViewer(1), 'aria-label': '다음' }, '›')));
}

// ---------------------------------------------------------------- 아래 시트 (프롬프트·캐릭터·설정·생성 버튼)
// 화면 높이: 앱이 막 켜졌거나 뒤에서 돌아온 순간에는 0에 가까운 값이 올 수 있어서 큰 값을 고른다.
const viewH = () => {
  const H = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, window.visualViewport?.height || 0);
  return H >= 320 ? H : Math.max(H, screen.availHeight || 0, 640);
};
const snapHeights = () => {
  const H = viewH();
  const go = document.querySelector('.sc-gobar')?.offsetHeight || 118;
  const min = go + 64;
  return [min, Math.max(min + 160, Math.round(H * 0.58)), Math.max(min + 200, H - 70)];
};
function setSheetHeight(px, animate = true) {
  const el = document.getElementById('scene-sheet');
  if (!el) return;
  const [min, , max] = snapHeights();
  UI.h = Math.max(min, Math.min(max, px));
  el.classList.toggle('anim', animate);
  el.style.height = `${UI.h}px`;
  el.classList.toggle('collapsed', UI.h <= min + 4);
  document.documentElement.style.setProperty('--sheet-min', `${min}px`);
}
function snapTo(i) { UI.snap = i; setSheetHeight(snapHeights()[i]); }
// 지금 보이는 높이로 접힘을 판단한다 (기억해 둔 단계가 아니라)
const isCollapsed = () => UI.h <= snapHeights()[0] + 4;
function toggleSheet() { if (isCollapsed()) snapTo(1); else snapTo(0); }
function reapplySheet() { if (C && C.app() === 'scene') setSheetHeight(snapHeights()[UI.snap], false); }

let editors = [];
export function renderSheet(rebuild = false) {
  const el = document.getElementById('scene-sheet');
  if (!el) return;
  const show = C.app() === 'scene';
  el.hidden = !show;
  document.body.classList.toggle('scene-mode', show);
  if (!show) return;
  if (el.dataset.built && !rebuild) { editors.forEach((e) => e.refresh?.()); renderGoBar(); return; }
  const top = el.querySelector('.sc-body')?.scrollTop || 0;
  el.dataset.built = '1';
  el.innerHTML = '';
  editors = [];
  // 끌어서 높이 바꾸기 (손을 떼면 가까운 높이로 붙는다). 그냥 누르면 접기/펴기.
  // 폰 웹뷰에서 확실하게 받도록 터치 이벤트를 직접 쓰고, 마우스는 따로 받는다.
  let y0 = 0, h0 = 0, moved = false, dragging = false;
  const start = (y) => { dragging = true; moved = false; y0 = y; h0 = UI.h; el.classList.remove('anim'); };
  const move = (y) => { if (!dragging) return; const dy = y - y0; if (Math.abs(dy) > 10) moved = true; if (moved) setSheetHeight(h0 - dy, false); };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) { toggleSheet(); return; }
    const hs = snapHeights();
    let best = 0;
    hs.forEach((v, i) => { if (Math.abs(v - UI.h) < Math.abs(hs[best] - UI.h)) best = i; });
    snapTo(best);
  };
  const peek = h('div', { class: 'sc-peek' },
    h('span', { class: 'sc-peek-text' }, String(SC.prompt || '').replace(/\s+/g, ' ').slice(0, 120) || '프롬프트를 넣어 주세요'),
    h('span', { class: 'sc-peek-btn' }, '✏️ 편집'));
  const handle = h('div', { class: 'sc-handle' }, h('span', { class: 'grip' }), peek);
  handle.addEventListener('touchstart', (e) => start(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); move(e.touches[0].clientY); }, { passive: false });
  handle.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); end(); });
  handle.addEventListener('touchcancel', () => { moved = true; end(); });
  handle.addEventListener('mousedown', (e) => {
    start(e.clientY);
    const mm = (ev) => move(ev.clientY);
    const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); end(); };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  });

  const body = h('div', { class: 'sc-body' },
    modelRow(),
    promptBlock(),
    charBlock(),
    settingsBlock(),
    h('div', { class: 'row wrap gap6 sc-tools' },
      h('button', { type: 'button', class: 'btn small', onclick: openNotes }, '📒 노트'),
      h('label', { class: 'btn small file-btn' }, 'PNG에서 불러오기', h('input', { type: 'file', accept: 'image/png', hidden: true, onchange: (e) => importPng(e.target.files?.[0], e.target) })),
      C.confirmBtn('프롬프트 비우기', '한 번 더', () => { SC.prompt = ''; SC.negative = ''; SC.chars = []; save(); renderSheet(true); }, 'btn small ghost danger')));
  body.addEventListener('focusin', (e) => { if (e.target.matches('textarea, input[type=text]') && UI.snap < 2) snapTo(2); });
  el.append(handle, body, h('div', { class: 'sc-gobar' }));
  renderGoBar();
  requestAnimationFrame(() => { setSheetHeight(UI.h || snapHeights()[UI.snap], false); body.scrollTop = top; });
}

function modelRow() {
  const sel = h('select', { class: 'sc-model', onchange: (e) => { SC.model = e.target.value; save(); renderSheet(true); } }, SCENE_MODELS.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = SC.model;
  return h('div', { class: 'sc-model-row' }, sel,
    isV5Full(SC.model) ? h('div', { class: 'seg' }, [['high', 'High'], ['medium', 'Medium']].map(([v, l]) =>
      h('button', { type: 'button', class: `seg-b${SC.effort === v ? ' on' : ''}`, onclick: () => { SC.effort = v; save(); renderSheet(true); } }, l))) : null);
}

function promptBlock() {
  const isUc = SC.tab === 'uc';
  const ed = editor({ id: 'sc-prompt', get: () => (isUc ? SC.negative : SC.prompt), set: (v) => { if (isUc) SC.negative = v; else { SC.prompt = v; const p = document.querySelector('.sc-peek-text'); if (p) p.textContent = v.replace(/\s+/g, ' ').slice(0, 120); } save(); },
    placeholder: isUc ? '제외할 내용(Undesired Content)' : '프롬프트를 입력하세요. 태그를 치면 자동완성이 떠요' });
  editors.push(ed);
  const ucNote = isUc && sceneEffective(SC).ucPreset !== 'none' ? h('p', { class: 'muted small' }, `UC 프리셋(${UC_PRESETS.find(([k]) => k === SC.ucPreset)?.[1]}) 문구가 앞에 붙어요.`) : null;
  return h('section', { class: 'sc-sec' },
    h('div', { class: 'sc-tabs' },
      h('button', { type: 'button', class: `sc-tab${!isUc ? ' on' : ''}`, onclick: () => { SC.tab = 'prompt'; save(); renderSheet(true); } }, '프롬프트'),
      h('button', { type: 'button', class: `sc-tab${isUc ? ' on' : ''}`, onclick: () => { SC.tab = 'uc'; save(); renderSheet(true); } }, '제외할 내용 (UC)')),
    ed, ucNote);
}

function charBlock() {
  const custom = SC.posMode === 'custom';
  const cards = SC.chars.map((c, i) => {
    const tab = c.tab === 'uc' ? 'uc' : 'prompt';
    const ed = editor({ get: () => (tab === 'uc' ? c.uc || '' : c.prompt || ''), set: (v) => { if (tab === 'uc') c.uc = v; else c.prompt = v; save(); }, placeholder: tab === 'uc' ? '이 캐릭터에서 뺄 것' : 'girl, ...' });
    editors.push(ed);
    const on = c.enabled !== false;
    return h('div', { class: `sc-char${on ? '' : ' off'}` },
      h('div', { class: 'sc-char-head' },
        h('button', { type: 'button', class: `sc-switch${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => { c.enabled = !on; save(); renderSheet(true); } }, h('span')),
        h('b', {}, `캐릭터 ${i + 1}`),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'mini', disabled: i === 0, onclick: () => { SC.chars.splice(i - 1, 0, SC.chars.splice(i, 1)[0]); save(); renderSheet(true); }, 'aria-label': '위로' }, '▲'),
        h('button', { type: 'button', class: 'mini', disabled: i === SC.chars.length - 1, onclick: () => { SC.chars.splice(i + 1, 0, SC.chars.splice(i, 1)[0]); save(); renderSheet(true); }, 'aria-label': '아래로' }, '▼'),
        C.confirmBtn('삭제', '한 번 더', () => { SC.chars.splice(i, 1); save(); renderSheet(true); }, 'mini danger')),
      h('div', { class: 'sc-tabs small' },
        h('button', { type: 'button', class: `sc-tab${tab === 'prompt' ? ' on' : ''}`, onclick: () => { c.tab = 'prompt'; save(); renderSheet(true); } }, '프롬프트'),
        h('button', { type: 'button', class: `sc-tab${tab === 'uc' ? ' on' : ''}`, onclick: () => { c.tab = 'uc'; save(); renderSheet(true); } }, 'UC')),
      ed,
      custom ? posGrid(c) : null);
  });
  return h('section', { class: 'sc-sec' },
    h('div', { class: 'sc-sec-head' }, h('b', {}, '캐릭터 프롬프트'),
      h('div', { class: 'seg' }, [['ai', 'AI 선택'], ['custom', '위치 지정']].map(([v, l]) =>
        h('button', { type: 'button', class: `seg-b${SC.posMode === v ? ' on' : ''}`, onclick: () => { SC.posMode = v; save(); renderSheet(true); } }, l)))),
    cards,
    SC.chars.length < 6 ? h('button', { type: 'button', class: 'sc-add', onclick: () => { SC.chars.push({ prompt: '', uc: '', enabled: true, pos: { x: 0.5, y: 0.5 } }); save(); renderSheet(true); } }, '+ 캐릭터 추가') : null,
    SC.chars.length ? h('p', { class: 'muted small' }, '인원 태그(2girls 등)는 위 프롬프트에, 캐릭터 칸에는 girl/boy만 써요. 위 칸 캐릭터가 대체로 왼쪽에 와요.') : null);
}

function posGrid(c) {
  const cur = c.pos || { x: 0.5, y: 0.5 };
  const cells = [];
  for (let r = 0; r < 5; r++) for (let col = 0; col < 5; col++) {
    const x = 0.1 + col * 0.2, y = 0.1 + r * 0.2;
    const on = Math.abs(cur.x - x) < 0.01 && Math.abs(cur.y - y) < 0.01;
    cells.push(h('button', { type: 'button', class: `pos${on ? ' on' : ''}`, 'aria-label': `위치 ${col + 1},${r + 1}`, onclick: () => { c.pos = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }; save(); renderSheet(true); } }));
  }
  const [w, hh] = sceneSize(SC);
  return h('div', { class: 'pos-wrap' }, h('div', { class: 'pos-grid', style: `aspect-ratio:${w}/${hh}` }, cells), h('span', { class: 'muted small' }, '그림 안에서 이 캐릭터가 올 자리'));
}

function slider(key, { min, max, step, label, disabled, fmt = (v) => v }) {
  const out = h('span', { class: 'sl-val' }, fmt(SC[key]));
  const input = h('input', { type: 'range', min, max, step, value: SC[key], disabled,
    oninput: (e) => { SC[key] = Number(e.target.value); out.textContent = fmt(SC[key]); save(); renderGoBar(); summary(); } });
  return h('label', { class: `sl${disabled ? ' disabled' : ''}` }, h('span', { class: 'sl-head' }, h('span', {}, label), out), input);
}
function pick(key, options, { label, disabled, after } = {}) {
  const sel = h('select', { disabled, onchange: (e) => { SC[key] = e.target.value; save(); after?.(); renderGoBar(); summary(); } }, options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = SC[key];
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), sel);
}
function summaryText() {
  const e = sceneEffective(SC);
  return `${e.width}×${e.height} · ${e.steps}스텝 · 가이던스 ${e.scale}${e.rescale ? ` · 리스케일 ${e.rescale}` : ''} · ${SCENE_SAMPLERS.find(([k]) => k === e.sampler)?.[1] || e.sampler}${String(SC.seed).trim() ? ` · 시드 ${SC.seed}` : ''}`;
}
function summary() { const s = document.getElementById('sc-summary'); if (s) s.textContent = summaryText(); }

function settingsBlock() {
  const e = sceneEffective(SC);
  const v5 = isV5Full(SC.model);
  const sizeOpts = [...SCENE_SIZES.map(([k, l, w, hh]) => [k, `${l} ${w}×${hh}`]), ['custom', '직접 입력']];
  const seed = h('input', { type: 'number', inputmode: 'numeric', placeholder: '비우면 무작위', value: SC.seed, oninput: (ev) => { SC.seed = ev.target.value.trim(); save(); summary(); } });
  const det = h('details', { class: 'sc-sec sc-settings', open: UI.settingsOpen, ontoggle: (ev) => { UI.settingsOpen = ev.target.open; } },
    h('summary', {}, h('b', {}, '이미지 설정'), h('span', { id: 'sc-summary', class: 'muted small' }, summaryText())),
    h('div', { class: 'grid' },
      pick('size', sizeOpts, { label: '크기', after: () => renderSheet(true) }),
      SC.size === 'custom' ? h('div', { class: 'row gap6 span2' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '가로'), h('input', { type: 'number', step: 64, min: 64, value: SC.width, oninput: (ev) => { SC.width = Number(ev.target.value); save(); renderGoBar(); summary(); } })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '세로'), h('input', { type: 'number', step: 64, min: 64, value: SC.height, oninput: (ev) => { SC.height = Number(ev.target.value); save(); renderGoBar(); summary(); } }))) : null),
    slider('steps', { min: 1, max: 50, step: 1, label: e.medium ? '스텝 (Medium은 14 고정)' : '스텝', disabled: e.medium }),
    slider('scale', { min: 0, max: 10, step: 0.1, label: '프롬프트 가이던스', fmt: (v) => Number(v).toFixed(1) }),
    slider('rescale', { min: 0, max: 1, step: 0.02, label: e.medium ? '가이던스 리스케일 (Medium 없음)' : '가이던스 리스케일', disabled: e.medium, fmt: (v) => Number(v).toFixed(2) }),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '시드'),
      h('div', { class: 'row gap6' }, seed, h('button', { type: 'button', class: 'btn small', style: 'flex:0 0 auto', onclick: () => { SC.seed = ''; seed.value = ''; save(); summary(); } }, '무작위'))),
    h('div', { class: 'grid' },
      pick('sampler', SCENE_SAMPLERS, { label: '샘플러', disabled: e.medium }),
      pick('noise', NOISE_SCHEDULES, { label: '노이즈 스케줄' }),
      pick('quality', QUALITY_PRESETS, { label: '품질 태그 추가', disabled: !v5 }),
      pick('ucPreset', UC_PRESETS, { label: 'UC 프리셋', disabled: !v5 || e.medium })),
    h('div', { class: 'row between ac-row' },
      h('div', {}, h('b', {}, '태그 자동완성'), h('p', { class: 'muted small' }, '켜면 입력 중에 태그 후보가 한 줄로 떠요 (한글로 찾기 가능)')),
      h('button', { type: 'button', class: `sc-switch${SC.autocomplete ? ' on' : ''}`, 'aria-pressed': SC.autocomplete ? 'true' : 'false', 'aria-label': '태그 자동완성', onclick: (ev) => { SC.autocomplete = !SC.autocomplete; save(); ev.currentTarget.classList.toggle('on', SC.autocomplete); ev.currentTarget.setAttribute('aria-pressed', SC.autocomplete ? 'true' : 'false'); if (!SC.autocomplete) document.querySelectorAll('.ed-sug').forEach((x) => { x.hidden = true; }); } }, h('span'))),
    !v5 ? h('p', { class: 'muted small' }, '품질 태그·UC 프리셋은 V5 Full에서만 붙여요.') : null);
  return det;
}

function renderCounts() {
  const c = document.getElementById('sc-count');
  const waitN = G.filter((g) => g.status === 'wait').length;
  const runN = G.filter((g) => g.status === 'run').length;
  if (c) c.textContent = [runN ? '생성 중' : '', waitN ? `대기 ${waitN}장` : ''].filter(Boolean).join(' · ');
  const hn = document.getElementById('sc-hist-n');
  if (hn) hn.textContent = String(doneList().length);
  const b = document.getElementById('sc-clear');
  if (b) b.hidden = !waitN;
}

export function renderGoBar() {
  renderCounts();
  const bar = document.querySelector('.sc-gobar');
  if (!bar) return;
  bar.innerHTML = '';
  const e = sceneEffective(SC);
  const free = isFreeForOpus({ width: e.width, height: e.height, steps: e.steps });
  const sub = C.sub();
  const busy = busyCount();
  const running = G.some((g) => g.status === 'run');
  const n = Math.max(1, Math.round(SC.count) || 1);
  const info = [];
  if (sub?.usage) info.push(h('span', { class: `go-usage${sub.usage.percent <= 10 ? ' low' : ''}` }, `Opus 무료 ${sub.usage.percent}% 남음`, h('span', { class: 'muted' }, ` (약 ${Math.round(sub.usage.percent * IMAGES_PER_PERCENT).toLocaleString('ko-KR')}장)`)));
  else if (sub) info.push(h('span', {}, `Anlas ${(sub.anlas ?? 0).toLocaleString('ko-KR')}`));
  info.push(h('span', { class: free ? 'go-free' : 'go-paid' }, free ? '무료 범위' : 'Anlas 듦'));
  if (busy) info.push(h('span', { class: 'go-queue' }, running ? `생성 중 · 대기 ${busy - 1}` : `대기 ${busy}`));
  const step = (d) => { SC.count = Math.max(1, Math.min(50, n + d)); save(); renderGoBar(); };
  bar.append(
    h('div', { class: 'go-info' }, info),
    h('div', { class: 'go-row' },
      h('div', { class: 'stepper' },
        h('button', { type: 'button', onclick: () => step(-1), disabled: n <= 1, 'aria-label': '한 장 덜' }, '−'),
        h('b', {}, `×${n}`),
        h('button', { type: 'button', onclick: () => step(1), 'aria-label': '한 장 더' }, '+')),
      h('button', { type: 'button', class: `go-btn${busy ? ' queue' : ''}`, onclick: reserve },
        h('b', {}, busy ? '예약 추가' : '생성'), h('span', {}, n > 1 ? `${n}장` : busy ? '지금 설정 그대로' : '1장'))));
}

// ---------------------------------------------------------------- PNG 메타데이터 불러오기 (novelai.net에 그림을 끌어다 놓을 때와 같다)
async function readPngText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('PNG 파일이 아니에요.');
  const out = {};
  const dec = new TextDecoder();
  for (let p = 8; p + 8 <= buf.length;) {
    const len = dv.getUint32(p);
    const type = dec.decode(buf.subarray(p + 4, p + 8));
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') { const z = data.indexOf(0); out[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(z + 1)); }
    else if (type === 'iTXt') {
      const z = data.indexOf(0);
      const key = dec.decode(data.subarray(0, z));
      let q = z + 3;
      q = data.indexOf(0, q) + 1;
      q = data.indexOf(0, q) + 1;
      if (data[z + 1] === 0) out[key] = dec.decode(data.subarray(q));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}
const QSUFFIX = [', very aesthetic, masterpiece, no text', ', very aesthetic, amazing quality, no text'];
async function importPng(file, input) {
  if (!file) return;
  try {
    const t = await readPngText(file);
    if (!t.Comment) throw new Error('NovelAI 생성 정보가 없는 그림이에요.');
    const m = JSON.parse(t.Comment);
    let prompt = m.v4_prompt?.caption?.base_caption ?? m.prompt ?? '';
    let quality = 'none';
    QSUFFIX.forEach((s, i) => { if (prompt.endsWith(s)) { prompt = prompt.slice(0, -s.length); quality = i ? 'light' : 'standard'; } });
    const ucBase = m.v4_negative_prompt?.caption?.base_caption ?? m.uc ?? '';
    const pc = m.v4_prompt?.caption?.char_captions || [];
    const nc = m.v4_negative_prompt?.caption?.char_captions || [];
    const coords = Boolean(m.v4_prompt?.use_coords);
    SC.prompt = prompt;
    SC.negative = ucBase;
    SC.quality = isV5Full(SC.model) ? quality : 'none';
    SC.ucPreset = 'none';
    SC.chars = pc.map((c, i) => ({ prompt: c.char_caption || '', uc: nc[i]?.char_caption || '', enabled: true, pos: c.centers?.[0] ? { x: c.centers[0].x, y: c.centers[0].y } : { x: 0.5, y: 0.5 } }));
    SC.posMode = coords ? 'custom' : 'ai';
    if (m.steps) SC.steps = m.steps;
    if (m.scale != null) SC.scale = m.scale;
    if (m.cfg_rescale != null) SC.rescale = m.cfg_rescale;
    if (m.sampler && SCENE_SAMPLERS.some(([k]) => k === m.sampler)) SC.sampler = m.sampler;
    if (m.noise_schedule && NOISE_SCHEDULES.some(([k]) => k === m.noise_schedule)) SC.noise = m.noise_schedule;
    if (m.width && m.height) {
      const p = SCENE_SIZES.find(([, , w, hh]) => w === m.width && hh === m.height);
      if (p) SC.size = p[0];
      else { SC.size = 'custom'; SC.width = m.width; SC.height = m.height; }
    }
    SC.seed = m.seed != null ? String(m.seed) : '';
    SC.tab = 'prompt';
    save();
    renderSheet(true);
    C.toast(`불러왔어요${pc.length ? ` (캐릭터 ${pc.length}명)` : ''}. 시드도 넣었어요`, 'ok');
  } catch (e) {
    C.toast(`불러오지 못했어요: ${e?.message || e}`, 'bad');
  } finally { if (input) input.value = ''; }
}


// ---------------------------------------------------------------- 노트: 직접 쓰는 빈 노트 (상황 / 캐릭터)
// 상황 노트: 제목·설명·베이스(장면 태그)·네거티브·캐릭터 칸 여러 개·썸네일
// 캐릭터 노트: 이름·설명·캐릭터 프롬프트·캐릭터 UC·썸네일
// [넣기]는 지금 프롬프트를 지우지 않고 덧붙인다(그림체 블록은 그대로). 캐릭터는 캐릭터 칸을 새로 만든다.
const N = { open: false, tab: 'scene', edit: null, q: '', folder: 'all', picker: false };
const saveNotes = () => store.kvSet('notes', NOTES).catch(() => {});
const notesOf = (kind) => NOTES.filter((x) => x.kind === kind);
const noteFolders = (kind) => [...new Set(notesOf(kind).map((x) => x.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
const blank = (x) => !String(x.name || '').trim() && !String(x.desc || '').trim() && !String(x.base || x.prompt || '').trim() && !String(x.negative || x.uc || '').trim() && !(x.chars || []).some((c) => String(c.prompt || c.uc || '').trim()) && !x.thumb;

function openNotes() { N.open = true; N.edit = null; N.picker = false; N.q = ''; renderNotes(); }
function closeNotes() { leaveNote(); N.open = false; renderNotes(); }
// 아무것도 안 쓴 새 노트는 나갈 때 지운다
function leaveNote() {
  const x = N.edit && NOTES.find((y) => y.id === N.edit);
  if (x && blank(x)) NOTES = NOTES.filter((y) => y !== x);
  saveNotes();
  N.edit = null;
  N.picker = false;
}
function newNote(kind) {
  const now = Date.now();
  const x = kind === 'scene'
    ? { id: `n${now}`, kind, name: '', folder: N.folder !== 'all' ? N.folder : '', desc: '', base: '', negative: '', chars: [], thumb: null, created: now, updated: now }
    : { id: `c${now}`, kind, name: '', folder: N.folder !== 'all' ? N.folder : '', desc: '', prompt: '', uc: '', thumb: null, created: now, updated: now };
  NOTES.push(x);
  N.edit = x.id;
  renderNotes();
}

// 프롬프트 끝에 덧붙이기 (앞 내용이 쉼표로 끝나지 않으면 쉼표를 넣는다)
function appendText(cur, add) {
  const a = String(add || '').trim();
  if (!a) return cur;
  const c = String(cur || '').replace(/\s+$/, '');
  if (!c) return a;
  return `${c}${/,$/.test(c) ? '' : ','}\n${a}`;
}
function insertNote(x, part) {
  const done = [];
  if (x.kind === 'char') {
    SC.chars.push({ prompt: x.prompt || '', uc: x.uc || '', enabled: true, pos: { x: 0.5, y: 0.5 } });
    done.push('캐릭터 칸');
  } else {
    if ((part === 'all' || part === 'base') && String(x.base || '').trim()) { SC.prompt = appendText(SC.prompt, x.base); done.push('베이스'); }
    if ((part === 'all' || part === 'negative') && String(x.negative || '').trim()) { SC.negative = appendText(SC.negative, x.negative); done.push('네거티브'); }
    const chars = (x.chars || []).filter((c) => String(c.prompt || '').trim() || String(c.uc || '').trim());
    const pick = part === 'all' ? chars : typeof part === 'number' ? [x.chars[part]].filter(Boolean) : [];
    for (const c of pick) SC.chars.push({ prompt: c.prompt || '', uc: c.uc || '', enabled: true, pos: { x: 0.5, y: 0.5 } });
    if (pick.length) done.push(`캐릭터 ${pick.length}칸`);
  }
  if (!done.length) { C.toast('넣을 내용이 없어요', 'bad'); return; }
  if (SC.chars.length > 6) C.toast('캐릭터 칸이 6개를 넘었어요. V4.5 이하는 6명까지예요');
  save();
  closeNotes();
  renderSheet(true);
  if (UI.snap === 0) snapTo(1);
  C.toast(`넣었어요: ${done.join(' · ')}`, 'ok');
}

// 썸네일: 작게 줄여 JPEG로 저장한다 (원본 그림은 건드리지 않는다)
async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 384 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
}
async function setThumb(x, blob) {
  try {
    const small = await makeThumb(blob);
    const id = `thumb-${x.id}-${Date.now()}`;
    await store.imagePut(id, small);
    if (x.thumb) dropThumb(x.thumb);
    x.thumb = id;
    x.updated = Date.now();
    saveNotes();
    N.picker = false;
    renderNotes();
  } catch (e) { C.toast(`썸네일을 만들지 못했어요: ${e?.message || e}`, 'bad'); }
}
function dropThumb(id) {
  store.imageDelete(id).catch(() => {});
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
}
function thumbEl(x, cls = 'note-thumb') {
  if (!x.thumb) return h('div', { class: `${cls} empty` }, x.kind === 'char' ? '👤' : '🎬');
  const img = h('img', { alt: '' });
  urlFor(x.thumb).then((u) => { if (u) img.src = u; });
  return h('div', { class: cls }, img);
}

async function exportNotes() {
  const out = [];
  for (const x of NOTES) {
    const y = { ...x };
    if (x.thumb) {
      const b = await store.imageGet(x.thumb).catch(() => null);
      if (b) y.thumbData = `data:image/jpeg;base64,${C.toBase64(new Uint8Array(await b.arrayBuffer()))}`;
    }
    out.push(y);
  }
  const blob = new Blob([JSON.stringify({ app: 'nai-supporter', type: 'notes', version: 2, exported: Date.now(), notes: out }, null, 1)], { type: 'application/json' });
  C.saveFile(`노트_${C.stamp()}.json`, blob);
}
async function importNotes(file, input) {
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const list = Array.isArray(j) ? j : j.notes;
    if (!Array.isArray(list)) throw new Error('노트 파일이 아니에요.');
    let added = 0, updated = 0;
    for (const raw of list) {
      if (!raw || (raw.kind !== 'scene' && raw.kind !== 'char')) continue;
      const { thumbData, ...x } = raw;
      const cur = NOTES.find((y) => y.id === x.id);
      if (cur && (x.updated || 0) <= (cur.updated || 0)) continue;
      if (thumbData) {
        const id = `thumb-${x.id}-${Date.now()}`;
        await store.imagePut(id, new Blob([C.fromBase64(thumbData)], { type: 'image/jpeg' }));
        x.thumb = id;
      } else x.thumb = null;
      if (cur) { if (cur.thumb && cur.thumb !== x.thumb) dropThumb(cur.thumb); Object.assign(cur, x); updated++; } else { NOTES.push(x); added++; }
    }
    saveNotes();
    renderNotes();
    C.toast(`가져왔어요: 새로 ${added}개${updated ? ` · 갱신 ${updated}개` : ''}`, 'ok');
  } catch (e) { C.toast(`가져오지 못했어요: ${e?.message || e}`, 'bad'); } finally { if (input) input.value = ''; }
}

function renderNotes() {
  const root = document.getElementById('snotes');
  root.innerHTML = '';
  root.hidden = !N.open;
  document.body.classList.toggle('sheet-open', N.open);
  if (!N.open) return;
  const panel = h('div', { class: 'sheet-panel notes-panel', role: 'dialog', 'aria-label': '노트' });
  root.append(h('div', { class: 'sheet-back', onclick: closeNotes }), panel);
  const x = N.edit && NOTES.find((y) => y.id === N.edit);
  const kids = x && N.picker ? thumbPicker(x) : x ? noteEditor(x) : noteList();
  panel.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

function noteList() {
  const kind = N.tab;
  const listBox = h('div', { class: 'notes-list' });
  const folders = noteFolders(kind);
  if (N.folder !== 'all' && !folders.includes(N.folder) && N.folder !== '') N.folder = 'all';
  const mine = notesOf(kind);
  const draw = () => {
    listBox.innerHTML = '';
    const q = N.q.trim().toLowerCase();
    const list = mine.filter((y) => (N.folder === 'all' || (y.folder || '') === N.folder) &&
      (!q || [y.name, y.desc, y.folder, y.base, y.negative, y.prompt, y.uc, ...(y.chars || []).map((c) => c.prompt)].some((t) => String(t || '').toLowerCase().includes(q))))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!list.length) { listBox.append(h('p', { class: 'empty' }, mine.length ? '맞는 노트가 없어요.' : kind === 'scene' ? '아직 상황 노트가 없어요. "+ 새 상황"을 눌러 써 보세요.' : '아직 캐릭터 노트가 없어요. "+ 새 캐릭터"를 눌러 써 보세요.')); return; }
    for (const y of list) {
      const text = kind === 'scene' ? y.base : y.prompt;
      const nChars = kind === 'scene' ? (y.chars || []).filter((c) => String(c.prompt || '').trim()).length : 0;
      listBox.append(h('button', { type: 'button', class: 'note-item', onclick: () => { N.edit = y.id; renderNotes(); } },
        thumbEl(y),
        h('div', { class: 'note-text' },
          h('div', { class: 'note-top' }, h('b', { class: 'note-name' }, y.name || '(제목 없음)'), y.folder ? h('span', { class: 'note-folder' }, `📁 ${y.folder}`) : null),
          y.desc ? h('span', { class: 'note-memo' }, y.desc) : null,
          text ? h('span', { class: 'note-prompt' }, String(text).replace(/\s+/g, ' ').slice(0, 100)) : null,
          nChars ? h('span', { class: 'muted small' }, `캐릭터 ${nChars}칸`) : null)));
    }
  };
  draw();
  const chipList = [['all', `전체 ${mine.length}`], ...folders.map((f) => [f, `📁 ${f}`]), ...(folders.length && mine.some((y) => !y.folder) ? [['', '폴더 없음']] : [])];
  return [
    h('div', { class: 'row between' }, h('div', { class: 'sheet-title' }, '📒 노트'), h('button', { class: 'btn small ghost', onclick: closeNotes }, '닫기')),
    h('div', { class: 'sc-tabs' },
      h('button', { type: 'button', class: `sc-tab${kind === 'scene' ? ' on' : ''}`, onclick: () => { N.tab = 'scene'; N.folder = 'all'; renderNotes(); } }, `상황 ${notesOf('scene').length}`),
      h('button', { type: 'button', class: `sc-tab${kind === 'char' ? ' on' : ''}`, onclick: () => { N.tab = 'char'; N.folder = 'all'; renderNotes(); } }, `캐릭터 ${notesOf('char').length}`)),
    h('button', { class: 'btn primary wide', onclick: () => newNote(kind) }, kind === 'scene' ? '+ 새 상황' : '+ 새 캐릭터'),
    h('input', { type: 'search', class: 'notes-search', placeholder: '제목·설명·프롬프트 검색', value: N.q, oninput: (e) => { N.q = e.target.value; draw(); } }),
    chipList.length > 1 ? h('div', { class: 'subtabs' }, chipList.map(([v, l]) => h('button', { type: 'button', class: `subtab${N.folder === v ? ' on' : ''}`, onclick: () => { N.folder = v; renderNotes(); } }, l))) : null,
    listBox,
    h('div', { class: 'row wrap gap6' },
      h('button', { class: 'btn small', onclick: exportNotes, disabled: !NOTES.length }, '파일로 내보내기'),
      h('label', { class: 'btn small file-btn' }, '파일에서 가져오기', h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => importNotes(e.target.files?.[0], e.target) }))),
  ];
}

// 노트 한 장 편집. 입력하는 대로 저장된다.
function noteEditor(x) {
  const touch = () => { x.updated = Date.now(); saveNotes(); };
  const fid = `fl-${x.id}`;
  const field = (label, el, actions) => h('div', { class: 'note-field' },
    h('div', { class: 'note-field-head' }, h('span', { class: 'field-label' }, label), actions ? h('div', { class: 'row gap6' }, actions) : null), el);
  const acts = (text, what, ins) => [
    h('button', { type: 'button', class: 'mini', onclick: () => { if (String(text() || '').trim()) C.copy(text(), what); else C.toast('비어 있어요', 'bad'); } }, '복사'),
    ins ? h('button', { type: 'button', class: 'mini accent', onclick: ins }, '넣기') : null];
  const ed = (get, set, placeholder) => editor({ get, set: (v) => { set(v); touch(); }, placeholder });
  const back = () => { leaveNote(); renderNotes(); };
  const head = [
    h('div', { class: 'row between' }, h('button', { class: 'btn small ghost', onclick: back }, '‹ 목록'), h('button', { class: 'btn small ghost', onclick: closeNotes }, '닫기')),
    h('div', { class: 'note-head' },
      h('button', { type: 'button', class: 'note-thumb-btn', onclick: () => { N.picker = true; renderNotes(); }, 'aria-label': '썸네일 고르기' }, thumbEl(x, 'note-thumb big'), h('span', { class: 'note-thumb-label' }, x.thumb ? '바꾸기' : '썸네일')),
      h('div', { class: 'note-head-fields' },
        h('input', { type: 'text', class: 'note-title', placeholder: x.kind === 'char' ? '캐릭터 이름' : '상황 제목', value: x.name, oninput: (e) => { x.name = e.target.value; touch(); } }),
        h('input', { type: 'text', list: fid, placeholder: '폴더 (비워도 돼요)', value: x.folder || '', oninput: (e) => { x.folder = e.target.value.trim(); touch(); } }),
        h('datalist', { id: fid }, noteFolders(x.kind).map((f) => h('option', { value: f }))))),
    field('설명', h('textarea', { class: 'note', rows: 3, placeholder: x.kind === 'char' ? '어떤 캐릭터인지, 주의할 점 등' : '어떤 상황인지, 잘 나온 조합, 주의할 태그 등', value: x.desc || '', oninput: (e) => { x.desc = e.target.value; touch(); } })),
  ];
  let body;
  if (x.kind === 'char') {
    body = [
      field('캐릭터 프롬프트', ed(() => x.prompt || '', (v) => { x.prompt = v; }, 'girl, 외형 태그, ...'), acts(() => x.prompt, '캐릭터 프롬프트', () => insertNote(x))),
      field('캐릭터 UC', ed(() => x.uc || '', (v) => { x.uc = v; }, '이 캐릭터에서 뺄 것'), acts(() => x.uc, '캐릭터 UC')),
      h('button', { class: 'btn primary wide', onclick: () => insertNote(x) }, '캐릭터 칸으로 넣기'),
    ];
  } else {
    const chars = x.chars || (x.chars = []);
    body = [
      field('베이스 (장면)', ed(() => x.base || '', (v) => { x.base = v; }, '장면·구도·조명 태그 (그림체 블록은 빼고)'), acts(() => x.base, '베이스', () => insertNote(x, 'base'))),
      field('네거티브', ed(() => x.negative || '', (v) => { x.negative = v; }, '이 상황에서 뺄 것'), acts(() => x.negative, '네거티브', () => insertNote(x, 'negative'))),
      chars.map((c, i) => field(`캐릭터 ${i + 1}`,
        h('div', { class: 'note-char' },
          ed(() => c.prompt || '', (v) => { c.prompt = v; }, 'girl, ...'),
          ed(() => c.uc || '', (v) => { c.uc = v; }, '캐릭터 UC (선택)')),
        [...acts(() => c.prompt, `캐릭터 ${i + 1}`, () => insertNote(x, i)),
          C.confirmBtn('삭제', '한 번 더', () => { chars.splice(i, 1); touch(); renderNotes(); }, 'mini danger')])),
      h('button', { type: 'button', class: 'sc-add', onclick: () => { chars.push({ prompt: '', uc: '' }); touch(); renderNotes(); } }, '+ 캐릭터 칸'),
      h('button', { class: 'btn primary wide', onclick: () => insertNote(x, 'all') }, '전부 넣기 (베이스·네거티브는 끝에 덧붙이고, 캐릭터는 새 칸으로)'),
    ];
  }
  return [...head, ...body.flat(),
    h('p', { class: 'muted small' }, `만든 날 ${C.when(x.created)} · 고친 날 ${C.when(x.updated)}`),
    h('div', { class: 'row wrap gap6' },
      h('button', { class: 'btn small', onclick: () => { const now = Date.now(); const y = { ...JSON.parse(JSON.stringify(x)), id: `${x.kind === 'char' ? 'c' : 'n'}${now}`, name: `${x.name || '제목 없음'} (복사)`, thumb: null, created: now, updated: now }; NOTES.push(y); saveNotes(); N.edit = y.id; renderNotes(); C.toast('복제했어요 (썸네일은 빼고)', 'ok'); } }, '복제'),
      C.confirmBtn('노트 삭제', '한 번 더', () => { if (x.thumb) dropThumb(x.thumb); NOTES = NOTES.filter((y) => y !== x); saveNotes(); N.edit = null; renderNotes(); C.toast('지웠어요'); }))];
}

// 썸네일 고르기: 상황 뽑기에서 뽑은 그림 또는 폰 갤러리
function thumbPicker(x) {
  const done = doneList().slice(0, 90);
  return [
    h('div', { class: 'row between' }, h('button', { class: 'btn small ghost', onclick: () => { N.picker = false; renderNotes(); } }, '‹ 노트'), h('div', { class: 'sheet-title' }, '썸네일 고르기')),
    h('div', { class: 'row wrap gap6' },
      h('label', { class: 'btn file-btn' }, '📷 갤러리에서 고르기', h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { const f = e.target.files?.[0]; if (f) setThumb(x, f); e.target.value = ''; } })),
      x.thumb ? h('button', { class: 'btn ghost', onclick: () => { dropThumb(x.thumb); x.thumb = null; x.updated = Date.now(); saveNotes(); N.picker = false; renderNotes(); } }, '썸네일 빼기') : null),
    h('b', {}, '뽑은 그림에서 고르기'),
    done.length ? h('div', { class: 'thumb-pick' }, done.map((g) => {
      const img = h('img', { alt: `시드 ${g.seed}`, loading: 'lazy' });
      urlFor(g.imgId).then((u) => { if (u) img.src = u; });
      return h('button', { type: 'button', class: 'thumb-cell', onclick: async () => { const b = await store.imageGet(g.imgId); if (b) setThumb(x, b); } }, img);
    })) : h('p', { class: 'empty' }, '아직 뽑은 그림이 없어요.'),
  ];
}

// ---------------------------------------------------------------- 뒤로 가기
export function sceneBack() {
  if (UI.viewer) { closeViewer(); return true; }
  if (UI.lp) { hideLp(); return true; }
  if (N.open) { if (N.picker) { N.picker = false; renderNotes(); } else if (N.edit) { leaveNote(); renderNotes(); } else closeNotes(); return true; }
  if (C.app() === 'scene' && UI.snap > 0) { snapTo(0); return true; }
  if (C.app() === 'scene' && SC.stab === 'hist') { SC.stab = 'gen'; save(); C.renderView(); return true; }
  return false;
}

window.addEventListener('resize', reapplySheet);
window.visualViewport?.addEventListener('resize', reapplySheet);
window.addEventListener('pageshow', reapplySheet);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(reapplySheet, 120); });
document.addEventListener('touchstart', (e) => { if (UI.lp && !e.target.closest?.('.sc-lp')) hideLp(); }, { passive: true, capture: true });
document.addEventListener('keydown', (e) => {
  if (!UI.viewer) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowRight') stepViewer(1);
  if (e.key === 'ArrowLeft') stepViewer(-1);
});
