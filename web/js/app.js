// NAI 작가 셔플: 프롬프트 속 작가 가중치를 섞어 조합을 만들고, 조합마다 그림을 뽑아 탭으로 비교한다.
import { VERSION, REPO } from './version.js';
import { DEFAULT_SETTINGS, DEFAULT_FAVS } from './defaults.js';
import { parse, artists, build, artistLine, shuffleWeights, topArtists, fmt } from './shuffle.js';
import { MODELS, SAMPLERS, SIZES, RETRY_STATUSES, RETRY_DELAYS, AUTH_STATUSES, generateImage, fetchSubscription, randomSeed, buildPayload } from './nai.js';
import * as store from './store.js';
import {
  native, Filesystem, toBase64, http, copyToClipboard, openExternal, downloadBlob, onBackButton, minimizeApp,
  styleStatusBar, keepAwake, backgroundWork, backgroundNotice, askNotifications, batteryState, shareFile, Gen, fromBase64,
} from './platform.js';

// ---------------------------------------------------------------- tiny DOM helper
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const two = (n) => String(n).padStart(2, '0');
const stamp = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};
const when = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

// 두 번 눌러야 실행되는 버튼(지우기 등). 확인 창을 쓰지 않는다.
function confirmBtn(label, sure, fn, cls = 'btn small ghost danger') {
  const b = h('button', { class: cls, type: 'button' }, label);
  let armed = false, timer;
  b.addEventListener('click', () => {
    if (armed) { clearTimeout(timer); fn(); return; }
    armed = true;
    b.textContent = sure;
    b.classList.add('armed');
    timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 2500);
  });
  return b;
}

// ---------------------------------------------------------------- state
const S = {
  settings: { ...DEFAULT_SETTINGS },
  locks: {},
  favs: [],
  counter: 0,
  view: 'make',
  runs: [],
  currentRunId: null,
  tab: 0,
  sub: null,
};
const urls = new Map();  // 그림 id -> object URL

async function load() {
  const [settings, locks, favs, counter] = await Promise.all([store.kvGet('settings'), store.kvGet('locks'), store.kvGet('favs'), store.kvGet('counter')]);
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  S.locks = locks || {};
  S.favs = Array.isArray(favs) ? favs : DEFAULT_FAVS.map((f) => ({ ...f }));
  S.counter = Number(counter) || 8;
  S.runs = await store.runList();
  // 앱이 꺼지면서 멈춘 그림은 '중단'으로 표시해 다시 뽑을 수 있게 한다.
  // (폰에서는 생성 서비스가 계속 뽑고 있을 수 있으므로 서비스 상태를 받아 본 뒤에 정한다.)
  if (!native) for (const run of S.runs) {
    let changed = false;
    for (const c of run.combos) for (const im of c.images) if (im.status === 'wait' || im.status === 'run') { im.status = 'stop'; changed = true; }
    if (changed) await store.runPut(run);
  }
  S.currentRunId = S.runs[0]?.id || null;
  if (!favs) await store.kvSet('favs', S.favs);
}

let saveTimer;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.kvSet('settings', S.settings).catch(() => {}), 300);
}
const saveLocks = () => store.kvSet('locks', S.locks).catch(() => {});
const saveFavs = () => store.kvSet('favs', S.favs).catch(() => {});
const runById = (id) => S.runs.find((r) => r.id === id);
const currentRun = () => runById(S.currentRunId);

// ---------------------------------------------------------------- generation queue
const Q = { items: [], busy: false, cancel: false, done: 0, total: 0, waitUntil: 0 };

function enqueue(run, list) {
  for (const [ci, ii] of list) {
    run.combos[ci].images[ii].status = 'wait';
    run.combos[ci].images[ii].error = '';
    Q.items.push({ runId: run.id, ci, ii });
  }
  store.runPut(run).catch(() => {});
  if (native) {
    Q.items = Q.items.filter((i) => i.runId !== run.id || !list.some(([ci, ii]) => ci === i.ci && ii === i.ii));
    nativeEnqueue(run, list);
    renderAll();
    return;
  }
  Q.total += list.length;
  if (!Q.busy) processQueue();
  renderAll();
}

// ---------------------------------------------------------------- 폰: 생성 서비스에 맡기기
// 서비스(네이티브)가 NovelAI 요청과 저장을 직접 하므로 화면이 멈춰도 계속 뽑는다.
// 화면이 보일 때마다 끝난 그림을 가져와 탭에 채운다.
const keyOf = (run, ci, ii) => `${run.id}_${ci}_${ii}`;
function parseKey(k) {
  const m = String(k).match(/^(r\d+)_(\d+)_(\d+)$/);
  return m ? { runId: m[1], ci: Number(m[2]), ii: Number(m[3]) } : null;
}

async function nativeEnqueue(run, list) {
  let jobs;
  try {
    jobs = list.map(([ci, ii]) => {
      const c = run.combos[ci];
      return { key: keyOf(run, ci, ii), body: JSON.stringify(buildPayload({ ...run.params, prompt: c.prompt }, c.images[ii].seed)) };
    });
    askNotifications();
    pending++;
    try { await Gen.genEnqueue({ apiKey: S.settings.apiKey, jobs }); } finally { pending--; }
    Q.busy = true;
    wasBusy = true;
  } catch (e) {
    for (const [ci, ii] of list) { const im = run.combos[ci].images[ii]; im.status = 'stop'; im.error = String(e?.message || e); }
    store.runPut(run).catch(() => {});
    toast(`뽑기를 시작하지 못했어요: ${e?.message || e}`, 'bad');
  }
  syncNative();
}

let syncing = false, wasBusy = false, synced = false, pending = 0;
async function syncNative() {
  if (!native || syncing) return;
  syncing = true;
  try {
    const st = await Gen.genStatus();
    const results = Array.isArray(st.results) ? st.results : [];
    const queued = new Set(Array.isArray(st.queueKeys) ? st.queueKeys : []);
    const touched = new Set();
    const cells = [];
    const acks = [];
    let fatal = '';
    for (const r of results) {
      acks.push(r.key);
      const k = parseKey(r.key);
      const run = k && runById(k.runId);
      const combo = run?.combos[k.ci];
      const im = combo?.images[k.ii];
      if (!im) continue;
      if (r.status === 'done') {
        try {
          const f = await Filesystem.readFile({ path: `gen/img/${r.key}.png`, directory: 'DATA' });
          const id = `${run.id}-${combo.no}-${k.ii}-${im.seed}`;
          await store.imagePut(id, new Blob([fromBase64(f.data)], { type: 'image/png' }));
          im.id = id;
          im.status = 'done';
          im.error = '';
        } catch (e) {
          im.status = 'fail';
          im.error = `그림 파일을 읽지 못했어요: ${e?.message || e}`;
        }
      } else {
        im.status = r.status === 'fail' ? 'fail' : 'stop';
        im.error = r.error || '';
        if (r.fatal) fatal = r.error || '';
      }
      touched.add(run);
      cells.push([run, k.ci, k.ii]);
    }
    const busy = Boolean(st.running) || queued.size > 0;
    for (const run of S.runs) {
      run.combos.forEach((c, ci) => c.images.forEach((im, ii) => {
        const key = keyOf(run, ci, ii);
        if (key === st.current) {
          if (im.status !== 'run') { im.status = 'run'; cells.push([run, ci, ii]); }
        } else if (im.status === 'run' && queued.has(key)) {
          im.status = 'wait'; cells.push([run, ci, ii]);
        } else if ((im.status === 'run' || im.status === 'wait') && !queued.has(key) && !busy && !pending) {
          im.status = 'stop'; touched.add(run); cells.push([run, ci, ii]);
        }
      }));
    }
    for (const run of touched) await store.runPut(run).catch(() => {});
    if (acks.length) await Gen.genAck({ keys: acks }).catch(() => {});
    Q.busy = busy;
    Q.done = Number(st.done) || 0;
    Q.total = Number(st.total) || 0;
    Q.waitUntil = st.retryIn > 0 ? Date.now() + st.retryIn * 1000 : 0;
    for (const [run, ci, ii] of cells) updateCell(run, ci, ii);
    if (wasBusy && !busy && synced) {
      if (fatal) toast(fatal, 'bad');
      else toast('다 뽑았어요', 'ok');
    } else if (fatal) toast(fatal, 'bad');
    wasBusy = busy;
    synced = true;
    renderStatus();
    renderNav();
  } catch (e) {
    /* 다음 번에 다시 */
  } finally {
    syncing = false;
  }
}

function startNativeSync() {
  if (!native) return;
  syncNative();
  setInterval(() => { if (!document.hidden) syncNative(); }, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNative(); });
}

async function cancellableWait(seconds) {
  Q.waitUntil = Date.now() + seconds * 1000;
  renderStatus();
  while (Date.now() < Q.waitUntil && !Q.cancel) await sleep(250);
  Q.waitUntil = 0;
}

async function processQueue() {
  Q.busy = true;
  Q.cancel = false;
  askNotifications();
  keepAwake(true);
  let stopReason = '';
  while (Q.items.length && !Q.cancel) {
    const item = Q.items.shift();
    const run = runById(item.runId);
    if (!run) continue;
    const combo = run.combos[item.ci];
    const im = combo?.images[item.ii];
    if (!im) continue;
    im.status = 'run';
    updateCell(run, item.ci, item.ii);
    renderStatus();
    backgroundWork(true, '그림을 뽑는 중', `${Q.done + 1}/${Q.total} · 조합 ${combo.no}`);
    const params = { ...run.params, apiKey: S.settings.apiKey, prompt: combo.prompt };
    let ok = false;
    for (const delay of [...RETRY_DELAYS, null]) {
      if (Q.cancel) break;
      try {
        const png = await generateImage(params, im.seed);
        const id = `${run.id}-${combo.no}-${item.ii}-${im.seed}`;
        await store.imagePut(id, new Blob([png], { type: 'image/png' }));
        im.id = id;
        im.status = 'done';
        ok = true;
        break;
      } catch (error) {
        const status = error?.status;
        if (AUTH_STATUSES.includes(status) || status === 402 || status === 400) {
          im.status = 'fail';
          im.error = error.message;
          stopReason = error.message;
          Q.cancel = true;
          break;
        }
        const retryable = status === undefined || RETRY_STATUSES.includes(status);
        if (retryable && delay !== null) {
          im.error = `${error.message} · ${delay}초 뒤 다시 시도`;
          updateCell(run, item.ci, item.ii);
          await cancellableWait(delay);
          continue;
        }
        im.status = 'fail';
        im.error = error.message;
        break;
      }
    }
    if (!ok && im.status === 'run') im.status = 'stop';
    Q.done++;
    await store.runPut(run).catch(() => {});
    updateCell(run, item.ci, item.ii);
    renderStatus();
  }
  // 취소: 남은 그림은 '중단'으로
  if (Q.cancel) {
    for (const item of Q.items) {
      const run = runById(item.runId);
      const im = run?.combos[item.ci]?.images[item.ii];
      if (im && im.status === 'wait') im.status = 'stop';
    }
    for (const id of new Set(Q.items.map((i) => i.runId))) { const r = runById(id); if (r) await store.runPut(r).catch(() => {}); }
    Q.items = [];
  }
  const total = Q.done;
  Q.busy = false;
  Q.cancel = false;
  Q.done = 0;
  Q.total = 0;
  keepAwake(false);
  backgroundWork(false);
  if (document.hidden) backgroundNotice(stopReason ? '뽑기가 멈췄어요' : '다 뽑았어요', stopReason || `${total}장`);
  if (stopReason) toast(stopReason, 'bad');
  else if (total) toast(`${total}장 다 뽑았어요`, 'ok');
  renderAll();
}

// ---------------------------------------------------------------- making a run
function segsNow() { return parse(S.settings.prompt); }

function baseWeights(arts) {
  const picked = S.favs.filter((f) => f.pick);
  return arts.map((a) => {
    if (S.locks[a.name] || !picked.length) return a.w;
    const vals = picked.map((f) => f.w[a.name]).filter((v) => typeof v === 'number');
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : a.w;
  });
}

function validateShuffle() {
  const st = S.settings;
  if (!(st.min < st.max)) return '최소가 최대보다 작아야 해요.';
  if (st.avg < st.min || st.avg > st.max) return '평균은 최소와 최대 사이여야 해요.';
  return '';
}

function startRun() {
  const st = S.settings;
  if (!st.apiKey.trim()) { toast('설정 탭에서 NovelAI API 키를 먼저 넣어 주세요.', 'bad'); S.view = 'settings'; renderAll(); return; }
  const segs = segsNow();
  const arts = artists(segs);
  if (!arts.length) { toast('프롬프트에서 artist: 태그를 찾지 못했어요.', 'bad'); return; }
  const bad = validateShuffle();
  if (bad) { toast(bad, 'bad'); return; }
  const base = st.mode === 'vary' ? baseWeights(arts) : arts.map((a) => a.w);
  const locked = arts.map((a) => Boolean(S.locks[a.name]));
  const names = arts.map((a) => a.name);
  const [width, height] = SIZES[st.size] || [832, 1216];
  const n = Math.max(1, Math.min(20, Math.round(st.combos)));
  const k = Math.max(1, Math.min(10, Math.round(st.perCombo)));
  const fixed = Number.parseInt(String(st.fixedSeed).trim(), 10);
  const sharedSeeds = Array.from({ length: k }, (_, i) => (st.seedMode === 'fixed' && Number.isFinite(fixed) ? (fixed + i) : randomSeed()));
  const combos = [];
  for (let c = 0; c < n; c++) {
    const w = shuffleWeights(base, locked, st);
    if (!w) { toast('잠근 작가 때문에 평균을 맞출 수 없어요. 범위를 넓혀 주세요.', 'bad'); return; }
    S.counter++;
    const seeds = st.seedMode === 'diff' ? Array.from({ length: k }, randomSeed) : sharedSeeds;
    combos.push({ no: S.counter, weights: w, prompt: build(segs, w, { space: st.space }), images: seeds.map((seed) => ({ seed, status: 'wait', id: null, error: '' })) });
  }
  store.kvSet('counter', S.counter).catch(() => {});
  const run = {
    id: `r${Date.now()}`, created: Date.now(), names, combos,
    mode: st.mode, seedMode: st.seedMode,
    params: { negative: st.negative, charPrompt: st.charPrompt, charNegative: st.charNegative, model: st.model, width, height, steps: st.steps, cfg: st.cfg, rescale: st.rescale, sampler: st.sampler },
  };
  S.runs.unshift(run);
  S.currentRunId = run.id;
  S.tab = 0;
  S.view = 'result';
  const list = [];
  combos.forEach((c, ci) => c.images.forEach((_, ii) => list.push([ci, ii])));
  enqueue(run, list);
}

function moreImages(run, ci) {
  const k = Math.max(1, Math.min(10, Math.round(S.settings.perCombo)));
  const combo = run.combos[ci];
  const start = combo.images.length;
  for (let i = 0; i < k; i++) combo.images.push({ seed: randomSeed(), status: 'wait', id: null, error: '' });
  enqueue(run, Array.from({ length: k }, (_, i) => [ci, start + i]));
}

function retryImage(run, ci, ii) {
  if (!S.settings.apiKey.trim()) { toast('API 키를 먼저 넣어 주세요.', 'bad'); return; }
  enqueue(run, [[ci, ii]]);
}

// ---------------------------------------------------------------- favorites
const favKey = (run, combo) => `${run.id}:${combo.no}`;
function favOf(run, combo) { return S.favs.find((f) => f.src === favKey(run, combo)); }
function toggleFav(run, combo) {
  const f = favOf(run, combo);
  if (f) {
    S.favs = S.favs.filter((x) => x !== f);
    toast(`조합 ${combo.no}을 즐겨찾기에서 뺐어요`);
  } else {
    S.favs.unshift({ id: `f${Date.now()}`, src: favKey(run, combo), name: `조합 ${combo.no}`, note: '', pick: false, w: Object.fromEntries(run.names.map((n, i) => [n, combo.weights[i]])) });
    toast(`조합 ${combo.no}을 즐겨찾기에 넣었어요`, 'ok');
  }
  saveFavs();
  renderAll();
}

function weightsFromMap(map) {
  const arts = artists(segsNow());
  return arts.map((a) => (typeof map[a.name] === 'number' ? map[a.name] : a.w));
}

function useAsBase(map, label) {
  const segs = segsNow();
  S.settings.prompt = build(segs, weightsFromMap(map), { space: S.settings.space });
  saveSettings();
  S.view = 'make';
  renderAll();
  toast(`${label} 가중치를 프롬프트에 넣었어요`, 'ok');
}

// 받침에 따라 을/를
const eulReul = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '을' : '를'; };
async function copy(text, what = '프롬프트') {
  try { await copyToClipboard(text); toast(`${what}${eulReul(what)} 복사했어요`, 'ok'); } catch { toast('복사하지 못했어요', 'bad'); }
}

// ---------------------------------------------------------------- images: show, save, share
async function urlFor(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await store.imageGet(id);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}

async function publicFile(name, folder) {
  for (const [directory, path] of [['EXTERNAL_STORAGE', `${folder}/${name}`], ['DOCUMENTS', `NAIArtistShuffle/${name}`]]) {
    try {
      await Filesystem.writeFile({ path, directory, data: '', recursive: true });
      return { directory, path, label: directory === 'DOCUMENTS' ? '내 파일 › Documents › NAIArtistShuffle' : `내 파일 › ${folder}` };
    } catch { /* next */ }
  }
  return null;
}

async function saveImage(run, combo, im) {
  const blob = await store.imageGet(im.id);
  if (!blob) { toast('그림 파일을 찾지 못했어요', 'bad'); return; }
  const name = `조합${combo.no}_${im.seed}_${stamp(run.created)}.png`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!native) { downloadBlob(name, blob); toast('다운로드했어요', 'ok'); return; }
  try {
    const target = await publicFile(name, 'Pictures/NAIArtistShuffle');
    if (!target) { await shareImage(run, combo, im); return; }
    await Filesystem.writeFile({ path: target.path, directory: target.directory, data: toBase64(bytes), recursive: true });
    toast(`저장했어요: ${target.label}`, 'ok');
  } catch (e) {
    toast(`저장하지 못했어요: ${e?.message || e}`, 'bad');
  }
}

async function shareImage(run, combo, im) {
  const blob = await store.imageGet(im.id);
  if (!blob) return;
  if (!native) { downloadBlob(`조합${combo.no}_${im.seed}.png`, blob); return; }
  try {
    const path = `share/조합${combo.no}_${im.seed}.png`;
    await Filesystem.writeFile({ path, directory: 'CACHE', data: toBase64(new Uint8Array(await blob.arrayBuffer())), recursive: true });
    await shareFile({ path, directory: 'CACHE', title: `조합 ${combo.no}` });
  } catch (e) {
    if (!/cancel/i.test(String(e?.message))) toast(`공유하지 못했어요: ${e?.message || e}`, 'bad');
  }
}

// ---------------------------------------------------------------- viewer
const V = { open: false, runId: null, ci: 0, ii: 0 };
function openViewer(run, ci, ii) {
  Object.assign(V, { open: true, runId: run.id, ci, ii });
  renderViewer();
}
function closeViewer() { V.open = false; renderViewer(); }
function viewerStep(d) {
  const run = runById(V.runId);
  if (!run) return;
  const done = run.combos[V.ci].images.map((im, i) => [im, i]).filter(([im]) => im.status === 'done');
  const at = done.findIndex(([, i]) => i === V.ii);
  if (at < 0 || !done.length) return;
  V.ii = done[(at + d + done.length) % done.length][1];
  renderViewer();
}

async function renderViewer() {
  const root = document.getElementById('viewer');
  root.innerHTML = '';
  root.hidden = !V.open;
  if (!V.open) return;
  const run = runById(V.runId);
  const combo = run?.combos[V.ci];
  const im = combo?.images[V.ii];
  if (!im?.id) { closeViewer(); return; }
  const img = h('img', { alt: `조합 ${combo.no} 그림`, class: 'viewer-img' });
  urlFor(im.id).then((u) => { if (u) img.src = u; });
  let sx = 0, sy = 0;
  const stage = h('div', { class: 'viewer-stage', ontouchstart: (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; },
    ontouchend: (e) => { const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) viewerStep(dx < 0 ? 1 : -1); } }, img);
  const n = combo.images.filter((x) => x.status === 'done').length;
  const pos = combo.images.filter((x, i) => x.status === 'done' && i <= V.ii).length;
  root.append(
    h('div', { class: 'viewer-top' },
      h('span', { class: 'viewer-title' }, `조합 ${combo.no} · ${pos}/${n} · 시드 ${im.seed}`),
      h('button', { class: 'btn small ghost', onclick: closeViewer, 'aria-label': '닫기' }, '닫기')),
    stage,
    h('div', { class: 'viewer-bar' },
      h('button', { class: 'btn ghost', onclick: () => viewerStep(-1), 'aria-label': '이전 그림' }, '‹'),
      h('button', { class: 'btn', onclick: () => saveImage(run, combo, im) }, '저장'),
      h('button', { class: 'btn', onclick: () => shareImage(run, combo, im) }, '공유'),
      h('button', { class: 'btn', onclick: () => copy(String(im.seed), '시드') }, '시드 복사'),
      h('button', { class: 'btn ghost', onclick: () => viewerStep(1), 'aria-label': '다음 그림' }, '›')),
  );
}

// ---------------------------------------------------------------- views
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
function num(key, { step = 0.1, min, max, int = false } = {}) {
  return h('input', { type: 'number', id: `in-${key}`, inputmode: 'decimal', step, min, max, value: S.settings[key],
    oninput: (e) => { const v = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value); if (Number.isFinite(v)) { S.settings[key] = v; saveSettings(); renderMakeButton(); renderShuffleHint(); } } });
}
function select(key, options, after) {
  const el = h('select', { id: `in-${key}`, onchange: (e) => { S.settings[key] = e.target.value; saveSettings(); after?.(); } },
    options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = S.settings[key];
  return el;
}
function area(key, rows, placeholder, after) {
  return h('textarea', { id: `in-${key}`, rows, spellcheck: 'false', placeholder, value: S.settings[key],
    oninput: (e) => { S.settings[key] = e.target.value; saveSettings(); after?.(); } });
}

function renderArtistList(box) {
  box.innerHTML = '';
  const arts = artists(segsNow());
  const locked = arts.filter((a) => S.locks[a.name]).length;
  const avg = arts.length ? arts.reduce((x, a) => x + a.w, 0) / arts.length : 0;
  const summary = document.getElementById('artist-summary');
  if (summary) summary.textContent = arts.length ? `작가 ${arts.length}명 · 평균 ${avg.toFixed(2)}${locked ? ` · 고정 ${locked}` : ''}` : '작가 태그 없음';
  if (!arts.length) { box.append(h('p', { class: 'empty' }, '프롬프트에서 artist: 태그를 찾지 못했어요. "artist:이름" 형식으로 넣어 주세요.')); return; }
  for (const a of arts) {
    const on = Boolean(S.locks[a.name]);
    box.append(h('button', { type: 'button', class: `artist${on ? ' locked' : ''}`, 'aria-pressed': on ? 'true' : 'false',
      onclick: () => { if (S.locks[a.name]) delete S.locks[a.name]; else S.locks[a.name] = true; saveLocks(); renderArtistList(box); } },
    h('span', { class: 'artist-lock' }, on ? '고정' : ''), h('span', { class: 'artist-name' }, a.name), h('span', { class: 'artist-w' }, fmt(a.w))));
  }
}

function renderShuffleHint() {
  const el = document.getElementById('shuffle-hint');
  if (!el) return;
  const st = S.settings;
  const picked = S.favs.filter((f) => f.pick).map((f) => f.name);
  const bad = validateShuffle();
  el.classList.toggle('bad', Boolean(bad));
  el.textContent = bad || (st.mode === 'vary'
    ? `기준: ${picked.length ? `${picked.join(' + ')}의 평균` : '프롬프트의 지금 가중치'}에서 ±${st.jitter}씩 흔들고, 평균을 ${st.avg}로 맞춰요.`
    : `고정한 작가를 빼고 ${st.min}~${st.max} 사이에서 무작위로 뽑고, 평균을 ${st.avg}로 맞춰요.`);
  const jit = document.getElementById('jitter-field');
  if (jit) jit.hidden = st.mode !== 'vary';
  const fixed = document.getElementById('fixed-field');
  if (fixed) fixed.hidden = st.seedMode !== 'fixed';
}

function renderMakeButton() {
  const b = document.getElementById('make-btn');
  if (!b) return;
  const n = Math.max(1, Math.min(20, Math.round(S.settings.combos || 1)));
  const k = Math.max(1, Math.min(10, Math.round(S.settings.perCombo || 1)));
  b.textContent = Q.busy ? `뽑는 중 ${Q.done}/${Q.total} · 더 쌓기: ${n}조합 × ${k}장` : `${n}조합 × ${k}장 뽑기 (총 ${n * k}장)`;
}

function favCard(f) {
  const names = Object.keys(f.w);
  const ws = names.map((n) => f.w[n]);
  const note = h('input', { type: 'text', id: `note-${f.id}`, class: 'note', placeholder: '메모 (예: 채색 좋음)', value: f.note || '',
    oninput: (e) => { f.note = e.target.value; saveFavs(); } });
  return h('div', { class: 'card fav' },
    h('div', { class: 'row between' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: `pick-${f.id}`, checked: f.pick, onchange: (e) => { f.pick = e.target.checked; saveFavs(); renderShuffleHint(); } }), h('b', {}, f.name), h('span', { class: 'muted small' }, '기준')),
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn small', onclick: () => copy(artistLine(names, ws, S.settings.space), '작가 블록') }, '복사'),
        h('button', { class: 'btn small', onclick: () => useAsBase(f.w, f.name) }, '프롬프트에 넣기'),
        confirmBtn('삭제', '한 번 더', () => { S.favs = S.favs.filter((x) => x !== f); saveFavs(); renderAll(); }))),
    note,
    h('div', { class: 'top small' }, '주도 ', topArtists(names, ws).map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])));
}

function viewMake() {
  const st = S.settings;
  const artistBox = h('div', { class: 'artists' });
  const makeBtn = h('button', { id: 'make-btn', class: 'btn primary wide', onclick: startRun });
  const v = h('div', { class: 'view' },
    h('section', { class: 'card' },
      h('h2', {}, '프롬프트'),
      h('p', { class: 'muted small' }, '베이스 프롬프트 전체를 넣으세요. artist: 태그의 가중치만 바뀌고, 나머지 태그와 순서는 그대로 보내요.'),
      area('prompt', 10, '1.0::artist:이름 ::, ...', () => renderArtistList(artistBox)),
      h('details', {}, h('summary', {}, '베이스 네거티브'), area('negative', 5, '네거티브')),
      h('details', {}, h('summary', {}, '캐릭터 프롬프트 · 네거티브 (선택)'),
        area('charPrompt', 4, '장면·캐릭터 태그 (비워도 돼요)'), area('charNegative', 3, '캐릭터 네거티브'))),
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, '작가'), h('span', { id: 'artist-summary', class: 'muted small' })),
      h('p', { class: 'muted small' }, '눌러서 고정하면 그 작가의 가중치는 바뀌지 않아요.'),
      artistBox),
    h('section', { class: 'card' },
      h('h2', {}, '섞기'),
      h('div', { class: 'grid' },
        field('방식', select('mode', [['random', '완전 무작위'], ['vary', '기준에서 흔들기']], renderShuffleHint)),
        field('평균', num('avg', { step: 0.05, min: 0.1, max: 3 })),
        field('최소', num('min', { step: 0.1, min: 0, max: 3 })),
        field('최대', num('max', { step: 0.1, min: 0.1, max: 3 })),
        h('div', { id: 'jitter-field' }, field('흔들 폭 ±', num('jitter', { step: 0.05, min: 0.05, max: 1.5 }))),
        field('조합 수', num('combos', { step: 1, min: 1, max: 20, int: true })),
        field('조합당 장수', num('perCombo', { step: 1, min: 1, max: 10, int: true })),
        field('시드', select('seedMode', [['same', '조합끼리 같은 시드'], ['diff', '매번 다른 시드'], ['fixed', '시드 직접 지정']], renderShuffleHint)),
        h('div', { id: 'fixed-field' }, field('시작 시드', h('input', { type: 'number', id: 'in-fixedSeed', inputmode: 'numeric', value: st.fixedSeed, oninput: (e) => { S.settings.fixedSeed = e.target.value; saveSettings(); } }), '장마다 1씩 늘려요'))),
      h('p', { id: 'shuffle-hint', class: 'hint' }),
      h('p', { class: 'muted small' }, '"조합끼리 같은 시드"는 모든 조합이 같은 시드 세트를 써서 그림체 차이만 비교돼요.')),
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, '즐겨찾기'), h('span', { class: 'muted small' }, `${S.favs.length}개`)),
      h('p', { class: 'muted small' }, '"기준"을 체크한 즐겨찾기들의 평균이 "기준에서 흔들기"의 출발점이 돼요.'),
      S.favs.length ? S.favs.map(favCard) : h('p', { class: 'empty' }, '결과에서 ☆를 누르면 여기에 모여요.')),
    h('div', { class: 'sticky-go' }, makeBtn));
  setTimeout(() => { renderArtistList(artistBox); renderShuffleHint(); renderMakeButton(); }, 0);
  return v;
}

// --- results
const cellEls = new Map();  // `${runId}:${ci}:${ii}` -> element

function cellContent(run, ci, ii) {
  const combo = run.combos[ci];
  const im = combo.images[ii];
  const label = { wait: '대기', run: '생성 중', stop: '중단', fail: '실패' }[im.status];
  if (im.status === 'done' && im.id) {
    const img = h('img', { alt: `조합 ${combo.no} 그림 ${ii + 1}`, loading: 'lazy' });
    urlFor(im.id).then((u) => { if (u) img.src = u; });
    return h('button', { class: 'cell done', style: `aspect-ratio:${run.params.width}/${run.params.height}`, onclick: () => openViewer(run, ci, ii) }, img);
  }
  return h('div', { class: `cell ${im.status}`, style: `aspect-ratio:${run.params.width}/${run.params.height}` },
    im.status === 'run' ? h('div', { class: 'spinner' }) : null,
    h('span', { class: 'cell-label' }, label),
    im.error ? h('span', { class: 'cell-err' }, im.error) : null,
    (im.status === 'fail' || im.status === 'stop') ? h('button', { class: 'btn small', onclick: () => retryImage(run, ci, ii) }, '다시 뽑기') : null);
}

function updateCell(run, ci, ii) {
  const el = cellEls.get(`${run.id}:${ci}:${ii}`);
  if (el && el.isConnected) el.replaceWith(registerCell(run, ci, ii));
  updateTabs(run);
}
function registerCell(run, ci, ii) {
  const el = cellContent(run, ci, ii);
  cellEls.set(`${run.id}:${ci}:${ii}`, el);
  return el;
}

function tabState(combo) {
  const s = combo.images.map((i) => i.status);
  if (s.includes('run')) return 'run';
  if (s.includes('wait')) return 'wait';
  if (s.includes('fail')) return 'fail';
  return 'done';
}
function updateTabs(run) {
  const bar = document.getElementById('tabs');
  if (!bar || bar.dataset.run !== run.id) return;
  run.combos.forEach((c, i) => { const t = bar.children[i]; if (t) t.dataset.state = tabState(c); });
}

function setTab(i) {
  const run = currentRun();
  if (!run) return;
  S.tab = Math.max(0, Math.min(run.combos.length - 1, i));
  renderView();
  document.getElementById('tabs')?.children[S.tab]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function viewResult() {
  const run = currentRun();
  if (!run) return h('div', { class: 'view' }, h('section', { class: 'card' }, h('h2', {}, '아직 뽑은 조합이 없어요'), h('p', { class: 'muted' }, '뽑기 탭에서 조합을 뽑으면 여기에 조합마다 탭으로 나뉘어 나와요.'), h('button', { class: 'btn primary', onclick: () => { S.view = 'make'; renderAll(); } }, '뽑기로 가기')));
  if (S.tab >= run.combos.length) S.tab = 0;
  const combo = run.combos[S.tab];
  const ci = S.tab;
  const tabs = h('div', { id: 'tabs', class: 'tabs', 'data-run': run.id, role: 'tablist' },
    run.combos.map((c, i) => h('button', { role: 'tab', class: `tab${i === S.tab ? ' on' : ''}`, 'aria-selected': i === S.tab ? 'true' : 'false', 'data-state': tabState(c), onclick: () => setTab(i) },
      h('span', { class: 'dot' }), `${c.no}`, favOf(run, c) ? ' ★' : '')));
  const fav = favOf(run, combo);
  const cols = S.settings.cols || 2;
  const grid = h('div', { class: `cells cols${cols}` }, combo.images.map((_, ii) => registerCell(run, ci, ii)));
  let sx = 0, sy = 0;
  const panel = h('div', { class: 'panel', ontouchstart: (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; },
    ontouchend: (e) => { const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) setTab(S.tab + (dx < 0 ? 1 : -1)); } },
  h('div', { class: 'row between' },
    h('h2', {}, `조합 ${combo.no}`),
    h('div', { class: 'row gap6' },
      h('button', { class: `btn small${fav ? ' star' : ''}`, onclick: () => toggleFav(run, combo), 'aria-pressed': fav ? 'true' : 'false' }, fav ? '★ 즐겨찾기' : '☆ 즐겨찾기'),
      h('div', { class: 'seg', role: 'group', 'aria-label': '한 줄에 보일 그림 수' }, [1, 2, 3].map((n) => h('button', { class: `seg-b${cols === n ? ' on' : ''}`, onclick: () => { S.settings.cols = n; saveSettings(); renderView(); } }, `${n}`))))),
  h('div', { class: 'top small' }, '주도 ', topArtists(run.names, combo.weights).map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])),
  grid,
  h('div', { class: 'row wrap gap6' },
    h('button', { class: 'btn', onclick: () => copy(combo.prompt, '프롬프트') }, '프롬프트 복사'),
    h('button', { class: 'btn', onclick: () => copy(artistLine(run.names, combo.weights, S.settings.space), '작가 블록') }, '작가만 복사'),
    h('button', { class: 'btn', onclick: () => useAsBase(Object.fromEntries(run.names.map((n, i) => [n, combo.weights[i]])), `조합 ${combo.no}`) }, '프롬프트에 넣기'),
    h('button', { class: 'btn', onclick: () => moreImages(run, ci) }, `${Math.round(S.settings.perCombo)}장 더 뽑기`)),
  h('details', { class: 'weights' }, h('summary', {}, '가중치 전체 보기'),
    h('pre', {}, run.names.map((n, i) => `${fmt(combo.weights[i])}  ${n}`).join('\n'))));
  return h('div', { class: 'view' },
    h('div', { class: 'run-head' },
      h('div', {}, h('b', {}, when(run.created)), h('span', { class: 'muted small' }, ` · ${run.combos.length}조합 · ${run.mode === 'vary' ? '기준에서 흔들기' : '완전 무작위'} · ${{ same: '같은 시드', diff: '다른 시드', fixed: '지정 시드' }[run.seedMode] || ''}`)),
      h('span', { class: 'muted small' }, '옆으로 밀어 조합 넘기기')),
    tabs, panel);
}

// --- history
function viewHistory() {
  const v = h('div', { class: 'view' });
  if (!S.runs.length) { v.append(h('section', { class: 'card' }, h('h2', {}, '기록이 없어요'), h('p', { class: 'muted' }, '뽑은 조합은 여기에 날짜별로 쌓여요.'))); return v; }
  for (const run of S.runs) {
    const total = run.combos.reduce((x, c) => x + c.images.length, 0);
    const done = run.combos.reduce((x, c) => x + c.images.filter((i) => i.status === 'done').length, 0);
    const thumbs = h('div', { class: 'thumbs' });
    for (const c of run.combos.slice(0, 6)) {
      const im = c.images.find((i) => i.status === 'done');
      const t = h('div', { class: 'thumb', style: `aspect-ratio:${run.params.width}/${run.params.height}` });
      if (im) urlFor(im.id).then((u) => { if (u) t.append(h('img', { src: u, alt: '' })); });
      thumbs.append(t);
    }
    v.append(h('section', { class: `card run${run.id === S.currentRunId ? ' current' : ''}` },
      h('div', { class: 'row between' },
        h('div', {}, h('b', {}, when(run.created)), h('span', { class: 'muted small' }, ` · ${run.combos.length}조합 · ${done}/${total}장`)),
        h('div', { class: 'row gap6' },
          h('button', { class: 'btn small', onclick: () => { S.currentRunId = run.id; S.tab = 0; S.view = 'result'; renderAll(); } }, '열기'),
          confirmBtn('삭제', '한 번 더', () => deleteRun(run)))),
      h('div', { class: 'muted small' }, `조합 ${run.combos.map((c) => c.no).join(', ')}`),
      thumbs));
  }
  return v;
}

async function deleteRun(run) {
  if (Q.items.some((i) => i.runId === run.id) || (Q.busy && run.combos.some((c) => c.images.some((i) => i.status === 'run' || i.status === 'wait')))) { toast('뽑는 중인 기록은 지울 수 없어요. 먼저 멈춰 주세요.', 'bad'); return; }
  for (const c of run.combos) for (const im of c.images) if (im.id) {
    await store.imageDelete(im.id).catch(() => {});
    if (urls.has(im.id)) { URL.revokeObjectURL(urls.get(im.id)); urls.delete(im.id); }
  }
  await store.runDelete(run.id).catch(() => {});
  S.runs = S.runs.filter((r) => r !== run);
  if (S.currentRunId === run.id) S.currentRunId = S.runs[0]?.id || null;
  toast('기록을 지웠어요');
  renderAll();
}

// --- settings
function viewSettings() {
  const st = S.settings;
  const key = h('input', { type: 'password', id: 'in-apiKey', autocomplete: 'off', placeholder: 'pst-...', value: st.apiKey, oninput: (e) => { S.settings.apiKey = e.target.value.trim(); saveSettings(); } });
  const subBox = h('p', { class: 'muted small', id: 'sub-box' }, S.sub ? subText(S.sub) : '');
  const sizeOpts = Object.keys(SIZES).map((k) => [k, k]);
  const upd = h('p', { class: 'muted small', id: 'update-box' });
  return h('div', { class: 'view' },
    h('section', { class: 'card' },
      h('h2', {}, 'NovelAI API 키'),
      h('p', { class: 'muted small' }, 'novelai.net › 설정 › 계정 › Get Persistent API Token에서 받은 키(pst-로 시작)를 넣으세요. 이 폰 안에만 저장돼요.'),
      key,
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn small', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, '보기/숨기기'),
        h('button', { class: 'btn small', onclick: async () => {
          if (!S.settings.apiKey) { toast('키를 먼저 넣어 주세요', 'bad'); return; }
          subBox.textContent = '확인하는 중…';
          try { S.sub = await fetchSubscription(S.settings.apiKey); subBox.textContent = subText(S.sub); } catch (e) { subBox.textContent = e.message; }
        } }, '구독 확인')),
      subBox),
    h('section', { class: 'card' },
      h('h2', {}, '생성 설정'),
      h('div', { class: 'grid' },
        field('모델', select('model', MODELS.map((m) => [m, m]))),
        field('해상도', select('size', sizeOpts)),
        field('스텝', num('steps', { step: 1, min: 1, max: 50, int: true })),
        field('CFG', num('cfg', { step: 0.1, min: 0, max: 10 })),
        field('CFG 리스케일', num('rescale', { step: 0.05, min: 0, max: 1 })),
        field('샘플러', select('sampler', SAMPLERS.map((m) => [m, m])))),
      h('p', { class: 'muted small' }, '노이즈 스케줄은 karras로 보내요. Opus는 1MP 이하·28스텝 이하면 Anlas가 들지 않아요.')),
    h('section', { class: 'card' },
      h('h2', {}, '작가 태그 형식'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'in-space', checked: st.space, onchange: (e) => { S.settings.space = e.target.checked; saveSettings(); } }), h('span', {}, '`::` 앞에 공백 넣기 (예: 1.0::artist:이름 ::)'))),
    h('section', { class: 'card' },
      h('h2', {}, '백그라운드 생성'),
      h('p', { class: 'muted small' }, '그림은 앱과 따로 도는 생성 서비스가 뽑아요. 다른 앱을 쓰거나 화면을 꺼도 계속 뽑고, 앱을 다시 열면 결과가 채워져요. 배터리 최적화는 꺼 두세요.'),
      h('button', { class: 'btn small', onclick: async () => { const s = await batteryState(true); toast(s == null ? '폰 앱에서만 쓸 수 있어요' : s.unrestricted ? '이미 꺼져 있어요' : '설정 화면에서 허용해 주세요'); } }, '배터리 최적화 끄기')),
    h('section', { class: 'card' },
      h('h2', {}, '앱 정보'),
      h('p', { class: 'muted small' }, `NAI 작가 셔플 v${VERSION}`),
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn small', onclick: () => checkUpdate(upd) }, '업데이트 확인'),
        h('button', { class: 'btn small', onclick: () => openExternal(`https://github.com/${REPO}/releases/latest/download/NAI-Artist-Shuffle.apk`) }, '최신 APK 받기')),
      upd,
      h('p', { class: 'muted small', id: 'usage-box' })));
}
function subText(s) { return `${s.tier}${s.active ? '' : ' (만료)'} · Anlas ${s.anlas ?? '?'}`; }

async function checkUpdate(box) {
  box.textContent = '확인하는 중…';
  try {
    const res = await http({ url: `https://api.github.com/repos/${REPO}/releases/latest`, headers: { Accept: 'application/vnd.github+json' }, timeout: 15000 });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const latest = String(res.data.tag_name || '').replace(/^v/i, '');
    const p = (v) => v.split('.').map((x) => parseInt(x, 10) || 0);
    const [a, b] = [p(latest), p(VERSION)];
    let newer = false;
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) { newer = (a[i] || 0) > (b[i] || 0); break; } }
    box.textContent = newer ? `새 버전 v${latest}이 있어요. "최신 APK 받기"를 눌러 설치하세요.` : `최신 버전이에요 (v${VERSION}).`;
  } catch (e) {
    box.textContent = `확인하지 못했어요: ${e.message}`;
  }
}

// ---------------------------------------------------------------- frame
const VIEWS = [['make', '뽑기'], ['result', '결과'], ['history', '기록'], ['settings', '설정']];

function renderStatus() {
  const bar = document.getElementById('status');
  bar.innerHTML = '';
  bar.hidden = !Q.busy;
  if (Q.busy) {
    const wait = Q.waitUntil ? ` · ${Math.max(0, Math.ceil((Q.waitUntil - Date.now()) / 1000))}초 뒤 다시 시도` : '';
    bar.append(
      h('div', { class: 'status-bar', style: `--p:${Q.total ? (Q.done / Q.total) * 100 : 0}%` }),
      h('div', { class: 'status-row' },
        h('span', {}, `뽑는 중 ${Q.done}/${Q.total}${wait}`),
        h('button', { class: 'btn small ghost', onclick: () => { if (native) { Gen.genCancel().then(syncNative).catch(() => {}); } else Q.cancel = true; toast('지금 그림까지만 뽑고 멈춰요'); } }, '멈추기')));
  }
  renderMakeButton();
}

function renderView() {
  const main = document.getElementById('main');
  const y = window.scrollY;
  main.innerHTML = '';
  const fn = { make: viewMake, result: viewResult, history: viewHistory, settings: viewSettings }[S.view];
  main.append(fn());
  window.scrollTo(0, S.view === 'result' ? y : 0);
  if (S.view === 'settings') store.usage().then((u) => { const el = document.getElementById('usage-box'); if (el && u != null) el.textContent = `폰에 저장된 그림·기록: 약 ${(u / 1048576).toFixed(0)}MB`; });
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const [id, label] of VIEWS) {
    nav.append(h('button', { class: `nav-b${S.view === id ? ' on' : ''}`, 'aria-current': S.view === id ? 'page' : null,
      onclick: () => { const same = S.view === id; S.view = id; renderAll(); if (!same) window.scrollTo(0, 0); } }, label,
    id === 'result' && Q.busy ? h('span', { class: 'nav-dot' }) : null));
  }
}

function renderAll() {
  renderNav();
  renderView();
  renderStatus();
}

onBackButton(() => {
  if (V.open) { closeViewer(); return; }
  if (S.view !== 'make') { S.view = 'make'; renderAll(); return; }
  minimizeApp();
});
document.addEventListener('keydown', (e) => {
  if (!V.open) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowRight') viewerStep(1);
  if (e.key === 'ArrowLeft') viewerStep(-1);
});

(async () => {
  styleStatusBar();
  try {
    await load();
  } catch (e) {
    toast(`저장된 데이터를 읽지 못했어요: ${e?.message || e}`, 'bad');
  }
  document.getElementById('boot')?.remove();
  renderAll();
  startNativeSync();
  // 테스트용: 브라우저 미리보기에서 ?mock 이면 가짜 그림을 만든다.
  if (!native && /[?&]mock\b/.test(location.search)) window.__mock = true;
})();
