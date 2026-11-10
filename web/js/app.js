// NAI 작가 셔플: 프롬프트 속 작가 가중치를 섞어 조합을 만들고, 조합마다 그림을 뽑아 탭으로 비교한다.
import { VERSION, REPO } from './version.js';
import { DEFAULT_SETTINGS, DEFAULT_FAVS } from './defaults.js';
import { parse, artists, build, artistLine, shuffleWeights, topArtists, fmt, reorder, orderByNames, shuffledOrder } from './shuffle.js';
import { MODELS, SAMPLERS, SIZES, RETRY_STATUSES, RETRY_DELAYS, AUTH_STATUSES, generateImage, fetchSubscription, randomSeed, buildPayload, isFreeForOpus, IMAGES_PER_PERCENT } from './nai.js';
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
  orders: [],
  counter: 0,
  view: 'make',
  runs: [],
  currentRunId: null,
  tab: 0,
  favTab: 'like',
  app: 'shuffle',
  sceneView: 'scene-list',
  meta: {},
  folders: [],
  cups: [],
  styleLimit: 60,
  detail: false,  // 결과 탭: false = 갤러리(조합마다 대표 그림), true = 조합 하나 크게
  sub: null,
};
const urls = new Map();  // 그림 id -> object URL

async function load() {
  const [settings, locks, favs, counter, orders] = await Promise.all([store.kvGet('settings'), store.kvGet('locks'), store.kvGet('favs'), store.kvGet('counter'), store.kvGet('orders')]);
  S.orders = Array.isArray(orders) ? orders : [];
  const [meta, folders, cups, app] = await Promise.all([store.kvGet('styleMeta'), store.kvGet('folders'), store.kvGet('cups'), store.kvGet('app')]);
  S.meta = meta && typeof meta === 'object' ? meta : {};
  S.folders = Array.isArray(folders) ? folders : [];
  S.cups = Array.isArray(cups) ? cups : [];
  S.app = app === 'scene' ? 'scene' : 'shuffle';
  document.documentElement.dataset.app = S.app;
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
  // 예전에 평가한 조합에도 출처(통계/탐색/무작위)를 채워 둔다. 회차를 지워 알 수 없으면 무작위로 본다.
  let filled = false;
  for (const f of S.favs) if (!f.kind && f.src) { const t = favTarget(f); f.kind = t?.combo.kind || 'random'; filled = true; }
  if (!favs || filled) await store.kvSet('favs', S.favs);
}

let saveTimer;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.kvSet('settings', S.settings).catch(() => {}), 300);
}
const saveLocks = () => store.kvSet('locks', S.locks).catch(() => {});
const saveFavs = () => store.kvSet('favs', S.favs).catch(() => {});
const saveOrders = () => store.kvSet('orders', S.orders).catch(() => {});
// 조합의 작가 순서 (조합마다 순서를 섞었으면 조합 것, 아니면 회차 것)
const namesOf = (run, combo) => combo.names || run.names;
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
    if (wasBusy && !busy) refreshSub();
    else if (busy && Date.now() - (S.sub?.at || 0) > 120000) refreshSub();
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
  refreshSub();
  if (stopReason) toast(stopReason, 'bad');
  else if (total) toast(`${total}장 다 뽑았어요`, 'ok');
  renderAll();
}

// ---------------------------------------------------------------- making a run
function segsNow() { return parse(S.settings.prompt); }

function baseWeights(arts) {
  const picked = S.favs.filter((f) => f.pick && rateOf(f) === 'like');
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

// ---------------------------------------------------------------- 통계 반영
const STRENGTH = { weak: ['약하게', 0.5], mid: ['보통', 1], strong: ['강하게', 2] };

// 작가마다 출발점: 좋게 본 평균(즐겨찾기 1, 애매함 0.5)에서 시작해, 통계 차이(diff)만큼 더 민다.
// 평가에 없던 작가는 프롬프트의 지금 가중치. 고정한 작가는 그대로.
// 평가가 어디서 나온 조합인지: 통계로 뽑힌 조합의 평가는 절반만 반영해 자기 강화를 줄인다.
function favKind(f) { return f.kind || favTarget(f)?.combo.kind || 'random'; }
const originFactor = (f) => (favKind(f) === 'stats' ? 0.5 : 1);
const meanDist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return a.length ? s / a.length : 0; };

// 좋게 본 조합(즐겨찾기·애매함)을 비슷한 것끼리 묶어 '취향 계열'로 나눈다. 평균 하나로 뭉개지지 않게.
// 거리 = 작가별 가중치 차이의 평균. 0.25 안쪽이면 같은 계열. 계열은 최대 6개.
function tasteClusters(names, fallback, exclude = new Set()) {
  const items = S.favs
    .filter((f) => (rateOf(f) === 'like' || rateOf(f) === 'meh') && f.w && Object.keys(f.w).length && !exclude.has(f.src))
    .map((f) => ({ f, v: names.map((n, i) => (typeof f.w[n] === 'number' ? f.w[n] : fallback[i])), wt: RATES[rateOf(f)].value * originFactor(f) }))
    .sort((a, b) => b.wt - a.wt);
  const clusters = [];
  const recenter = (c) => {
    const tw = c.items.reduce((x, it) => x + it.wt, 0);
    c.center = names.map((_, i) => c.items.reduce((x, it) => x + it.v[i] * it.wt, 0) / tw);
    c.weight = tw;
  };
  for (const it of items) {
    let best = null, bd = Infinity;
    for (const c of clusters) { const d = meanDist(it.v, c.center); if (d < bd) { bd = d; best = c; } }
    if (best && bd < 0.25) { best.items.push(it); recenter(best); } else { const c = { items: [it] }; recenter(c); clusters.push(c); }
  }
  while (clusters.length > 6) {
    clusters.sort((a, b) => b.weight - a.weight);
    const small = clusters.pop();
    let best = clusters[0], bd = Infinity;
    for (const c of clusters) { const d = meanDist(small.center, c.center); if (d < bd) { bd = d; best = c; } }
    best.items.push(...small.items);
    recenter(best);
  }
  return clusters.sort((a, b) => b.weight - a.weight);
}

// 통계 반영의 출발점들: 계열마다 중심 + 작가별 통계 차이 × 반영 강도. 고정한 작가는 그대로.
function statsPlan(arts) {
  const { rows, rated } = computeStats();
  if (!rated.length) return null;
  const st = S.settings;
  const k = (STRENGTH[st.statStrength] || STRENGTH.mid)[1];
  const by = new Map(rows.map((r) => [r.name, r]));
  const names = arts.map((a) => a.name);
  const now = arts.map((a) => a.w);
  const push = (center) => arts.map((a, i) => {
    if (S.locks[a.name]) return a.w;
    const r = by.get(a.name);
    return Math.min(st.max, Math.max(st.min, center[i] + (r ? k * r.diff : 0)));
  });
  const groups = tasteGroups(names, now);
  const centers = groups.length ? groups.map((g) => push(g.center)) : [push(now)];
  const likes = S.favs.filter((f) => (rateOf(f) === 'like' || rateOf(f) === 'meh') && f.w);
  return { centers, groups, likes, rated: rated.length };
}

// 이미 좋아한 조합과 거의 같으면(평균 차이 0.15 미만) 같은 자리를 맴도는 것이라 다시 만든다.
function tooCloseToLikes(names, w, likes) {
  for (const f of likes) {
    let sum = 0, n = 0;
    names.forEach((name, i) => { if (typeof f.w[name] === 'number') { sum += Math.abs(f.w[name] - w[i]); n++; } });
    if (n && sum / n < 0.15) return true;
  }
  return false;
}

// 작가 빼기: 고정하지 않은 작가 중 n명을 0으로.
function dropout(base, locked, n) {
  const free = base.map((_, i) => i).filter((i) => !locked[i]);
  const pick = shuffledOrder(free.length).slice(0, Math.min(n, Math.max(0, free.length - 2))).map((j) => free[j]);
  const b = base.slice(), l = locked.slice();
  for (const i of pick) { b[i] = 0; l[i] = true; }
  return { base: b, locked: l, dropped: pick };
}

// 싫어요 조합과 평균 차이가 0.2 미만이면 너무 비슷하다고 본다.
function tooCloseToHate(names, w, hates) {
  for (const f of hates) {
    let sum = 0, n = 0;
    names.forEach((name, i) => { if (typeof f.w[name] === 'number') { sum += Math.abs(f.w[name] - w[i]); n++; } });
    if (n && sum / n < 0.2) return true;
  }
  return false;
}

const KIND = { stats: '통계', explore: '탐색', merge: '합성' };
const kindTag = (c) => (c.kind ? h('span', { class: `kind ${c.kind}` }, c.kind === 'stats' && c.cluster ? `통계·계열${c.cluster}` : c.kind === 'merge' ? `합성 ${c.mergeLabel} (${c.ratio}:${100 - c.ratio})` : KIND[c.kind]) : null);
const MODE_LABEL = { random: '완전 무작위', vary: '기준에서 흔들기', stats: '통계 반영', merge: '합치기' };

function startRun() {
  const st = S.settings;
  if (!st.apiKey.trim()) { toast('설정 탭에서 NovelAI API 키를 먼저 넣어 주세요.', 'bad'); S.view = 'settings'; renderAll(); return; }
  const segs = segsNow();
  const arts = artists(segs);
  if (!arts.length) { toast('프롬프트에서 artist: 태그를 찾지 못했어요.', 'bad'); return; }
  const bad = validateShuffle();
  if (bad) { toast(bad, 'bad'); return; }
  const locked = arts.map((a) => Boolean(S.locks[a.name]));
  const names = arts.map((a) => a.name);
  let base = st.mode === 'vary' ? baseWeights(arts) : arts.map((a) => a.w);
  let hates = [];
  let plan_ = null;
  if (st.mode === 'stats') {
    const plan = statsPlan(arts);
    if (!plan) { toast('평가한 그림체가 없어서 통계를 반영할 수 없어요. 먼저 즐겨찾기·애매함·싫어요를 눌러 주세요.', 'bad'); return; }
    plan_ = plan;
    hates = st.avoidHate ? S.favs.filter((f) => rateOf(f) === 'hate' && f.w) : [];
  }
  let statsTurn = 0;
  const [width, height] = SIZES[st.size] || [832, 1216];
  const n = Math.max(1, Math.round(st.combos) || 1);
  const k = Math.max(1, Math.min(10, Math.round(st.perCombo)));
  const fixed = Number.parseInt(String(st.fixedSeed).trim(), 10);
  const sharedSeeds = Array.from({ length: k }, (_, i) => (st.seedMode === 'fixed' && Number.isFinite(fixed) ? (fixed + i) : randomSeed()));
  const combos = [];
  for (let c = 0; c < n; c++) {
    let w, kind = '', cluster = 0;
    const drops = st.dropout ? Math.max(0, Math.round(st.dropCount) || 0) : 0;
    const gen = (b, l, opts) => { const d = drops ? dropout(b, l, drops) : { base: b, locked: l }; return shuffleWeights(d.base, d.locked, opts); };
    if (st.mode === 'stats') {
      // 일부는 탐색용 완전 무작위, 나머지는 취향 계열을 돌아가며 출발점으로 삼아 흔든다.
      // 싫어요와 비슷하거나, 이미 좋아한 조합과 거의 같으면 다시 만든다.
      const explore = Math.random() * 100 < (Number(st.explore) || 0);
      kind = explore ? 'explore' : 'stats';
      const ci = explore ? -1 : statsTurn++ % plan_.centers.length;
      cluster = explore ? 0 : ci + 1;
      for (let t = 0; t < 40; t++) {
        w = explore
          ? gen(arts.map((a) => a.w), locked, { ...st, mode: 'random' })
          : gen(plan_.centers[ci], locked, { ...st, mode: 'vary' });
        if (!w) break;
        if (tooCloseToHate(names, w, hates)) continue;
        if (!explore && tooCloseToLikes(names, w, plan_.likes)) continue;
        break;
      }
    } else w = gen(base, locked, st);
    if (!w) { toast('잠근 작가 때문에 평균을 맞출 수 없어요. 범위를 넓혀 주세요.', 'bad'); return; }
    S.counter++;
    const seeds = st.seedMode === 'diff' ? Array.from({ length: k }, randomSeed) : sharedSeeds;
    const images = seeds.map((seed) => ({ seed, status: 'wait', id: null, error: '' }));
    if (st.shuffleOrder) {
      const order = shuffledOrder(names.length);
      const cw = order.map((i) => w[i]);
      combos.push({ no: S.counter, kind, cluster, names: order.map((i) => names[i]), weights: cw, prompt: build(reorder(segs, order), cw, { space: st.space }), images });
    } else {
      combos.push({ no: S.counter, kind, cluster, weights: w, prompt: build(segs, w, { space: st.space }), images });
    }
  }
  store.kvSet('counter', S.counter).catch(() => {});
  createRun(combos, { mode: st.mode, seedMode: st.seedMode, shuffleOrder: Boolean(st.shuffleOrder), names });
}

// 조합들로 새 회차를 만들고 뽑기 시작.
function createRun(combos, { mode, seedMode, shuffleOrder = false, names }) {
  const st = S.settings;
  const [width, height] = SIZES[st.size] || [832, 1216];
  const run = {
    id: `r${Date.now()}`, created: Date.now(), names, combos, mode, seedMode, shuffleOrder,
    params: { negative: st.negative, charPrompt: st.charPrompt, charNegative: st.charNegative, model: st.model, width, height, steps: st.steps, cfg: st.cfg, rescale: st.rescale, sampler: st.sampler },
  };
  S.runs.unshift(run);
  S.currentRunId = run.id;
  S.tab = 0;
  S.detail = false;
  S.view = 'result';
  const list = [];
  combos.forEach((c, ci) => c.images.forEach((_, ii) => list.push([ci, ii])));
  enqueue(run, list);
  window.scrollTo(0, 0);
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

// ---------------------------------------------------------------- 평가: 즐겨찾기 / 애매함 / 싫어요 (조합 = 그림체 단위)
// 애매함은 "어떤 부분은 좋고 어떤 부분은 별로"라서 통계에는 즐겨찾기의 절반(+0.5)으로 넣는다.
const RATES = {
  like: { label: '즐겨찾기', icon: '★', value: 1 },
  meh: { label: '애매함', icon: '◐', value: 0.5 },
  hate: { label: '싫어요', icon: '✕', value: -1 },
};
const rateOf = (f) => (f && RATES[f.rate] ? f.rate : 'like');
const favKey = (run, combo) => `${run.id}:${combo.no}`;
function favOf(run, combo) { return S.favs.find((f) => f.src === favKey(run, combo)); }
function doneImgs(combo) { return combo.images.filter((i) => i.status === 'done' && i.id).map((i) => ({ id: i.id, seed: i.seed })); }

// 즐겨찾기 항목이 가리키는 회차·조합 (회차를 지웠으면 null)
function favTarget(f) {
  if (!f?.src) return null;
  const [runId, no] = f.src.split(':');
  const run = runById(runId);
  if (!run) return null;
  const ci = run.combos.findIndex((c) => String(c.no) === no);
  return ci < 0 ? null : { run, ci, combo: run.combos[ci] };
}
// 지금 볼 수 있는 그림들 (회차가 남아 있으면 최신, 지웠으면 평가할 때 보관해 둔 것)
function favImgs(f) {
  const t = favTarget(f);
  return t ? doneImgs(t.combo) : (f.imgs || []);
}
function favRatio(f) {
  const t = favTarget(f);
  if (t) return [t.run.params.width, t.run.params.height];
  return f.ratio || [832, 1216];
}

async function forgetFav(f) {
  S.favs = S.favs.filter((x) => x !== f);
  // 회차를 이미 지운 평가라면, 보관해 두었던 그림도 같이 지운다.
  if (!favTarget(f)) for (const im of f.imgs || []) await dropImage(im.id);
}

function rateCombo(run, combo, rate) {
  const f = favOf(run, combo);
  const label = RATES[rate].label;
  if (f && rateOf(f) === rate) {
    forgetFav(f);
    toast(`조합 ${combo.no}의 ${label}를 지웠어요`);
  } else if (f) {
    f.rate = rate;
    f.imgs = doneImgs(combo);
    toast(`조합 ${combo.no} → ${label}`, 'ok');
  } else {
    const names = namesOf(run, combo);
    S.favs.unshift({
      id: `f${Date.now()}`, src: favKey(run, combo), name: comboTitle(combo), note: S.meta[favKey(run, combo)]?.note || '', pick: false, rate,
      order: names.slice(), w: Object.fromEntries(names.map((n, i) => [n, combo.weights[i]])),
      imgs: doneImgs(combo), ratio: [run.params.width, run.params.height], created: Date.now(), kind: combo.kind || 'random',
    });
    toast(`조합 ${combo.no} → ${label}`, 'ok');
  }
  saveFavs();
  afterRate();
}

// 회차를 지운 평가(그림만 남은 것)의 평가 바꾸기
function rateFav(f, rate) {
  const t = favTarget(f);
  if (t) { rateCombo(t.run, t.combo, rate); return; }
  if (rateOf(f) === rate) { forgetFav(f); toast(`${f.name}의 ${RATES[rate].label}를 지웠어요`); }
  else { f.rate = rate; toast(`${f.name} → ${RATES[rate].label}`, 'ok'); }
  saveFavs();
  afterRate();
}

function afterRate() {
  if (V.open) renderViewer();
  renderView();
}

function rateButtons(current, onRate, big = false) {
  return h('div', { class: `rate-row${big ? ' big' : ''}`, role: 'group', 'aria-label': '평가' },
    Object.entries(RATES).map(([key, r]) => h('button', {
      type: 'button', class: `rate-b ${key}${current === key ? ' on' : ''}`, 'aria-pressed': current === key ? 'true' : 'false',
      onclick: () => onRate(key),
    }, h('span', { class: 'rate-icon' }, r.icon), r.label)));
}

function rateBadge(rate) {
  if (!rate) return null;
  return h('span', { class: `badge ${rate}` }, `${RATES[rate].icon} ${RATES[rate].label}`);
}

function weightsFromMap(map, segs = segsNow()) {
  const arts = artists(segs);
  return arts.map((a) => (typeof map[a.name] === 'number' ? map[a.name] : a.w));
}

function useAsBase(map, label, order) {
  let segs = segsNow();
  if (order && order.length) segs = reorder(segs, orderByNames(artists(segs), order));
  S.settings.prompt = build(segs, weightsFromMap.call(null, map, segs), { space: S.settings.space });
  saveSettings();
  S.view = 'make';
  renderAll();
  toast(`${label}의 가중치${order ? '와 순서' : ''}를 프롬프트에 넣었어요`, 'ok');
}

// ---------------------------------------------------------------- 작가 순서
function setPromptSegs(segs) {
  S.settings.prompt = build(segs, artists(segs).map((a) => a.w), { space: S.settings.space });
  saveSettings();
  const ta = document.getElementById('in-prompt');
  if (ta) ta.value = S.settings.prompt;
  const box = document.getElementById('artist-list');
  if (box) renderArtistList(box);
}
function moveArtist(i, d) {
  const segs = segsNow();
  const n = artists(segs).length;
  const j = i + d;
  if (j < 0 || j >= n) return;
  const order = Array.from({ length: n }, (_, x) => x);
  [order[i], order[j]] = [order[j], order[i]];
  setPromptSegs(reorder(segs, order));
}
function shuffleOrderNow() {
  const segs = segsNow();
  const n = artists(segs).length;
  if (n < 2) return;
  setPromptSegs(reorder(segs, shuffledOrder(n)));
  toast('작가 순서를 섞었어요', 'ok');
}
function saveOrder(name) {
  const arts = artists(segsNow());
  if (!arts.length) return;
  const label = name.trim() || `순서 ${S.orders.length + 1}`;
  S.orders.unshift({ id: `o${Date.now()}`, name: label, names: arts.map((a) => a.name) });
  saveOrders();
  renderOrders();
  toast(`"${label}" 순서를 저장했어요`, 'ok');
}
function loadOrder(o) {
  const segs = segsNow();
  setPromptSegs(reorder(segs, orderByNames(artists(segs), o.names)));
  toast(`"${o.name}" 순서로 바꿨어요`, 'ok');
}
function renderOrders() {
  const box = document.getElementById('order-list');
  if (!box) return;
  box.innerHTML = '';
  if (!S.orders.length) { box.append(h('p', { class: 'empty' }, '저장한 순서가 없어요.')); return; }
  for (const o of S.orders) {
    box.append(h('div', { class: 'order-row' },
      h('span', { class: 'order-name' }, o.name, h('span', { class: 'muted small' }, ` · ${o.names.length}명`)),
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn small', onclick: () => loadOrder(o) }, '불러오기'),
        confirmBtn('삭제', '한 번 더', () => { S.orders = S.orders.filter((x) => x !== o); saveOrders(); renderOrders(); }))));
  }
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

async function saveImage(no, im, created = Date.now()) {
  const blob = await store.imageGet(im.id);
  if (!blob) { toast('그림 파일을 찾지 못했어요', 'bad'); return; }
  const name = `조합${no}_${im.seed}_${stamp(created)}.png`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!native) { downloadBlob(name, blob); toast('다운로드했어요', 'ok'); return; }
  try {
    const target = await publicFile(name, 'Pictures/NAIArtistShuffle');
    if (!target) { await shareImage(no, im); return; }
    await Filesystem.writeFile({ path: target.path, directory: target.directory, data: toBase64(bytes), recursive: true });
    toast(`저장했어요: ${target.label}`, 'ok');
  } catch (e) {
    toast(`저장하지 못했어요: ${e?.message || e}`, 'bad');
  }
}

async function shareImage(no, im) {
  const blob = await store.imageGet(im.id);
  if (!blob) return;
  if (!native) { downloadBlob(`조합${no}_${im.seed}.png`, blob); return; }
  try {
    const path = `share/조합${no}_${im.seed}.png`;
    await Filesystem.writeFile({ path, directory: 'CACHE', data: toBase64(new Uint8Array(await blob.arrayBuffer())), recursive: true });
    await shareFile({ path, directory: 'CACHE', title: `조합 ${no}` });
  } catch (e) {
    if (!/cancel/i.test(String(e?.message))) toast(`공유하지 못했어요: ${e?.message || e}`, 'bad');
  }
}

// ---------------------------------------------------------------- viewer
// seq: 넘겨 볼 그림체(조합)들. 마지막 사진에서 더 넘기면 다음 그림체로 간다.
const V = { open: false, seq: [], si: 0, ii: 0, from: '' };
const seqFromRun = (run) => run.combos.map((c, ci) => ({ runId: run.id, ci }));
const seqFromFavs = (list) => list.map((f) => { const t = favTarget(f); return t ? { runId: t.run.id, ci: t.ci } : { fav: f }; });

function seqItem(it) {
  if (it.fav) {
    const f = it.fav;
    return { no: f.name.replace(/^조합\s*/, ''), title: f.name, imgs: f.imgs || [], rate: rateOf(f), fav: f, ratio: favRatio(f), names: Object.keys(f.w || {}), weights: Object.values(f.w || {}), created: f.created || Date.now() };
  }
  const run = runById(it.runId);
  const combo = run?.combos[it.ci];
  if (!combo) return null;
  const fav = favOf(run, combo);
  return { no: combo.no, title: comboTitle(combo), imgs: doneImgs(combo), rate: fav ? rateOf(fav) : null, run, combo, ratio: [run.params.width, run.params.height], names: namesOf(run, combo), weights: combo.weights, created: run.created };
}

function openViewer(seq, si, ii, from = '') {
  Object.assign(V, { open: true, seq, si, ii, from });
  renderViewer();
}
function closeViewer() {
  // 결과 화면에서 열었다면, 확대 화면에서 넘겨 본 조합으로 탭을 맞춘다.
  const it = V.seq[V.si];
  if (V.from === 'result' && it?.runId === S.currentRunId && S.view === 'result' && S.detail && S.tab !== it.ci) {
    S.tab = it.ci;
    V.open = false;
    renderViewer();
    renderView();
    return;
  }
  V.open = false;
  renderViewer();
}
function viewerStep(d) {
  const cur = seqItem(V.seq[V.si]);
  if (!cur) return;
  const ni = V.ii + d;
  if (ni >= 0 && ni < cur.imgs.length) { V.ii = ni; renderViewer(); return; }
  // 다음(이전) 그림체 중 그림이 있는 것으로
  const n = V.seq.length;
  for (let step = 1; step <= n; step++) {
    const si = (V.si + d * step + n * n) % n;
    const it = seqItem(V.seq[si]);
    if (it && it.imgs.length) {
      V.si = si;
      V.ii = d > 0 ? 0 : it.imgs.length - 1;
      renderViewer();
      return;
    }
  }
}

function viewerRate(rate) {
  const it = seqItem(V.seq[V.si]);
  if (!it) return;
  if (it.run) rateCombo(it.run, it.combo, rate);
  else rateFav(it.fav, rate);
}

async function renderViewer() {
  const root = document.getElementById('viewer');
  root.innerHTML = '';
  root.hidden = !V.open;
  document.body.classList.toggle('viewer-open', V.open);
  if (!V.open) return;
  const it = seqItem(V.seq[V.si]);
  if (!it || !it.imgs.length) { closeViewer(); return; }
  if (V.ii >= it.imgs.length) V.ii = it.imgs.length - 1;
  const im = it.imgs[V.ii];
  const img = h('img', { alt: `${it.title} 그림 ${V.ii + 1}`, class: 'viewer-img' });
  urlFor(im.id).then((u) => { if (u) img.src = u; });
  let sx = 0, sy = 0;
  const stage = h('div', { class: 'viewer-stage', ontouchstart: (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; },
    ontouchend: (e) => { const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) viewerStep(dx < 0 ? 1 : -1); } }, img);
  const top = topArtists(it.names, it.weights, 3);
  root.append(
    h('div', { class: 'viewer-top' },
      h('div', { class: 'viewer-head' },
        h('div', { class: 'viewer-title' }, it.title, rateBadge(it.rate)),
        h('div', { class: 'viewer-sub' },
          h('span', { class: 'viewer-count' }, `사진 ${V.ii + 1} / ${it.imgs.length}`),
          h('span', { class: 'viewer-pos' }, `그림체 ${V.si + 1} / ${V.seq.length}`))),
      h('button', { class: 'btn ghost close', onclick: closeViewer, 'aria-label': '닫기' }, '닫기')),
    stage,
    h('div', { class: 'viewer-artists' }, top.map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])),
    rateButtons(it.rate, viewerRate, true),
    h('div', { class: 'viewer-bar' },
      h('button', { class: 'btn nav-arrow', onclick: () => viewerStep(-1), 'aria-label': '이전' }, '‹'),
      h('button', { class: 'btn', onclick: () => saveImage(it.no, im, it.created) }, '저장'),
      h('button', { class: 'btn', onclick: () => shareImage(it.no, im) }, '공유'),
      h('button', { class: 'btn', onclick: () => copy(String(im.seed), '시드') }, '시드'),
      h('button', { class: 'btn nav-arrow', onclick: () => viewerStep(1), 'aria-label': '다음' }, '›')),
  );
}

// ---------------------------------------------------------------- views
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
function num(key, { step = 0.1, min, max, int = false } = {}) {
  return h('input', { type: 'number', id: `in-${key}`, inputmode: 'decimal', step, min, max, value: S.settings[key],
    oninput: (e) => { const v = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value); if (Number.isFinite(v)) { S.settings[key] = v; saveSettings(); renderMakeButton(); renderShuffleHint(); renderUsage(); } } });
}
function select(key, options, after) {
  const el = h('select', { id: `in-${key}`, onchange: (e) => { S.settings[key] = e.target.value; saveSettings(); after?.(); renderUsage(); } },
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
  arts.forEach((a, i) => {
    const on = Boolean(S.locks[a.name]);
    box.append(h('div', { class: `artist${on ? ' locked' : ''}` },
      h('button', { type: 'button', class: 'artist-main', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { if (S.locks[a.name]) delete S.locks[a.name]; else S.locks[a.name] = true; saveLocks(); renderArtistList(box); } },
      h('span', { class: 'artist-no' }, `${i + 1}`), h('span', { class: 'artist-lock' }, on ? '고정' : ''), h('span', { class: 'artist-name' }, a.name), h('span', { class: 'artist-w' }, fmt(a.w))),
      h('button', { type: 'button', class: 'mv', 'aria-label': `${a.name} 위로`, disabled: i === 0, onclick: () => moveArtist(i, -1) }, '▲'),
      h('button', { type: 'button', class: 'mv', 'aria-label': `${a.name} 아래로`, disabled: i === arts.length - 1, onclick: () => moveArtist(i, 1) }, '▼')));
  });
}

function statsGroupsCount() {
  const arts = artists(segsNow());
  if (!arts.length) return 0;
  return Math.max(1, tasteGroups(arts.map((a) => a.name), arts.map((a) => a.w)).length);
}

function renderShuffleHint() {
  const el = document.getElementById('shuffle-hint');
  if (!el) return;
  const st = S.settings;
  const picked = S.favs.filter((f) => f.pick && rateOf(f) === 'like').map((f) => f.name);
  const bad = validateShuffle();
  el.classList.toggle('bad', Boolean(bad));
  const rated = S.favs.filter((f) => f.w && Object.keys(f.w).length).length;
  const noStats = st.mode === 'stats' && !rated;
  el.classList.toggle('bad', Boolean(bad) || noStats);
  el.textContent = bad || (noStats ? '평가한 그림체가 없어서 통계를 반영할 수 없어요. 결과나 확대 화면에서 즐겨찾기·애매함·싫어요를 먼저 눌러 주세요.'
    : st.mode === 'stats'
      ? `평가 ${rated}개를 비슷한 것끼리 묶은 취향 계열 ${statsGroupsCount()}개를 돌아가며 출발점으로 써요. 좋았던 작가는 올리고 별로였던 작가는 내려요(반영 강도: ${(STRENGTH[st.statStrength] || STRENGTH.mid)[0]}). ±${st.jitter}씩 흔들고, ${st.explore}%는 탐색용 완전 무작위예요. 이미 좋아한 조합과 거의 같은 조합${st.avoidHate ? '과 싫어요와 비슷한 조합' : ''}은 다시 만들어요.${st.dropout ? ` 조합마다 작가 ${st.dropCount}명을 빼요.` : ''} 평균은 ${st.avg}로 맞춰요.`
    : st.mode === 'vary'
      ? `기준: ${picked.length ? `${picked.join(' + ')}의 평균` : '프롬프트의 지금 가중치'}에서 ±${st.jitter}씩 흔들고, 평균을 ${st.avg}로 맞춰요.`
      : `고정한 작가를 빼고 ${st.min}~${st.max} 사이에서 무작위로 뽑고, 평균을 ${st.avg}로 맞춰요.`);
  const jit = document.getElementById('jitter-field');
  if (jit) jit.hidden = st.mode === 'random';
  const sf = document.getElementById('stats-fields');
  if (sf) sf.hidden = st.mode !== 'stats';
  const fixed = document.getElementById('fixed-field');
  if (fixed) fixed.hidden = st.seedMode !== 'fixed';
}

function renderMakeButton() {
  const b = document.getElementById('make-btn');
  if (!b) return;
  const n = Math.max(1, Math.round(S.settings.combos) || 1);
  const k = Math.max(1, Math.min(10, Math.round(S.settings.perCombo || 1)));
  b.textContent = Q.busy ? `뽑는 중 ${Q.done}/${Q.total} · 더 쌓기: ${n}조합 × ${k}장` : `${n}조합 × ${k}장 뽑기 (총 ${n * k}장)`;
}

function viewMake() {
  const st = S.settings;
  const artistBox = h('div', { class: 'artists', id: 'artist-list' });
  const orderName = h('input', { type: 'text', id: 'order-name', placeholder: '순서 이름 (예: 4번 순서)' });
  const makeBtn = h('button', { id: 'make-btn', class: 'btn primary wide', onclick: startRun });
  const v = h('div', { class: 'view' },
    usageCard(),
    h('section', { class: 'card' },
      h('h2', {}, '프롬프트'),
      h('p', { class: 'muted small' }, '베이스 프롬프트 전체를 넣으세요. artist: 태그의 가중치만 바뀌고, 나머지 태그와 순서는 그대로 보내요.'),
      area('prompt', 10, '1.0::artist:이름 ::, ...', () => renderArtistList(artistBox)),
      h('details', {}, h('summary', {}, '베이스 네거티브'), area('negative', 5, '네거티브')),
      h('details', {}, h('summary', {}, '캐릭터 프롬프트 · 네거티브 (선택)'),
        area('charPrompt', 4, '장면·캐릭터 태그 (비워도 돼요)'), area('charNegative', 3, '캐릭터 네거티브'))),
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, '작가'), h('span', { id: 'artist-summary', class: 'muted small' })),
      h('p', { class: 'muted small' }, '이름을 눌러 고정하면 가중치가 바뀌지 않아요. ▲▼로 순서를 바꾸면 프롬프트의 작가 순서도 같이 바뀌어요.'),
      h('div', { class: 'row wrap gap6' }, h('button', { class: 'btn small', onclick: shuffleOrderNow }, '순서 섞기')),
      artistBox,
      h('details', {}, h('summary', {}, '순서 저장 · 불러오기'),
        h('div', { class: 'row gap6' }, orderName, h('button', { class: 'btn small', style: 'flex:0 0 auto', onclick: () => { saveOrder(orderName.value); orderName.value = ''; } }, '지금 순서 저장')),
        h('div', { id: 'order-list', class: 'order-list' }))),
    h('section', { class: 'card' },
      h('h2', {}, '섞기'),
      h('div', { class: 'grid' },
        field('방식', select('mode', [['random', '완전 무작위'], ['vary', '기준에서 흔들기'], ['stats', '통계 반영']], renderShuffleHint)),
        field('평균', num('avg', { step: 0.05, min: 0.1, max: 3 })),
        field('최소', num('min', { step: 0.1, min: 0, max: 3 })),
        field('최대', num('max', { step: 0.1, min: 0.1, max: 3 })),
        h('div', { id: 'jitter-field' }, field('흔들 폭 ±', num('jitter', { step: 0.05, min: 0.05, max: 1.5 }))),
        h('div', { id: 'stats-fields', class: 'span2 grid' },
          field('반영 강도', select('statStrength', Object.entries(STRENGTH).map(([k, [label]]) => [k, label]), renderShuffleHint)),
          field('탐색 비율 %', num('explore', { step: 5, min: 0, max: 100, int: true })),
          h('label', { class: 'check span2' }, h('input', { type: 'checkbox', id: 'in-avoidHate', checked: S.settings.avoidHate, onchange: (e) => { S.settings.avoidHate = e.target.checked; saveSettings(); renderShuffleHint(); } }), h('span', {}, '싫어요와 비슷한 조합 피하기'))),
        field('조합 수', num('combos', { step: 1, min: 1, int: true })),
        field('조합당 장수', num('perCombo', { step: 1, min: 1, max: 10, int: true })),
        h('label', { class: 'check span2' }, h('input', { type: 'checkbox', id: 'in-dropout', checked: st.dropout, onchange: (e) => { S.settings.dropout = e.target.checked; saveSettings(); renderShuffleHint(); const f = document.getElementById('drop-field'); if (f) f.hidden = !e.target.checked; } }), h('span', {}, '작가 빼기 (조합마다 몇 명을 0으로)')),
        h('div', { id: 'drop-field', hidden: !st.dropout }, field('뺄 작가 수', num('dropCount', { step: 1, min: 1, max: 10, int: true }))),
        h('label', { class: 'check span2' }, h('input', { type: 'checkbox', id: 'in-shuffleOrder', checked: st.shuffleOrder, onchange: (e) => { S.settings.shuffleOrder = e.target.checked; saveSettings(); } }), h('span', {}, '조합마다 작가 순서도 섞기')),
        field('시드', select('seedMode', [['same', '조합끼리 같은 시드'], ['diff', '매번 다른 시드'], ['fixed', '시드 직접 지정']], renderShuffleHint)),
        h('div', { id: 'fixed-field' }, field('시작 시드', h('input', { type: 'number', id: 'in-fixedSeed', inputmode: 'numeric', value: st.fixedSeed, oninput: (e) => { S.settings.fixedSeed = e.target.value; saveSettings(); } }), '장마다 1씩 늘려요'))),
      h('p', { id: 'shuffle-hint', class: 'hint' }),
      h('p', { class: 'muted small' }, '"조합끼리 같은 시드"는 모든 조합이 같은 시드 세트를 써서 그림체 차이만 비교돼요. "기준에서 흔들기"의 기준은 즐겨찾기 탭에서 "흔들기 기준"을 체크해 골라요.')),
    h('div', { class: 'sticky-go' }, makeBtn));
  setTimeout(() => { renderArtistList(artistBox); renderOrders(); renderShuffleHint(); renderMakeButton(); renderUsage(); }, 0);
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
    const pos = combo.images.slice(0, ii).filter((x) => x.status === 'done' && x.id).length;
    return h('button', { class: 'cell done', style: `aspect-ratio:${run.params.width}/${run.params.height}`, onclick: () => openViewer(seqFromRun(run), ci, pos, 'result') }, img);
  }
  return h('div', { class: `cell ${im.status}`, style: `aspect-ratio:${run.params.width}/${run.params.height}` },
    im.status === 'run' ? h('div', { class: 'spinner' }) : null,
    h('span', { class: 'cell-label' }, label),
    im.error ? h('span', { class: 'cell-err' }, im.error) : null,
    (im.status === 'fail' || im.status === 'stop') ? h('button', { class: 'btn small', onclick: () => retryImage(run, ci, ii) }, '다시 뽑기') : null);
}

function updateCell(run, ci, ii) {
  if (S.view === 'result' && !S.detail && run.id === S.currentRunId) { refreshGallery(); return; }
  const el = cellEls.get(`${run.id}:${ci}:${ii}`);
  if (el && el.isConnected) el.replaceWith(registerCell(run, ci, ii));
  updateTabs(run);
}
// 갤러리는 여러 그림이 한꺼번에 들어올 수 있어 한 번에 몰아서 다시 그린다.
let galleryTimer = null;
function refreshGallery() {
  if (galleryTimer) return;
  galleryTimer = setTimeout(() => { galleryTimer = null; if (S.view === 'result' && !S.detail && !V.open) renderView(); }, 120);
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
}
// 번호 탭 줄에서 지금 조합이 가운데 오게 (다시 그려도 맨 앞으로 튀지 않게)
function centerActiveTab() {
  const bar = document.getElementById('tabs');
  const on = bar?.querySelector('.tab.on');
  if (!bar || !on) return;
  const b = bar.getBoundingClientRect(), a = on.getBoundingClientRect();
  bar.scrollLeft += (a.left + a.width / 2) - (b.left + b.width / 2);
}

function runHead(run, extra) {
  return h('div', { class: 'run-head' },
    h('div', {}, h('b', {}, when(run.created)), h('span', { class: 'muted small' }, ` · ${run.combos.length}조합 · ${MODE_LABEL[run.mode] || '완전 무작위'} · ${{ same: '같은 시드', diff: '다른 시드', fixed: '지정 시드' }[run.seedMode] || ''}${run.shuffleOrder ? ' · 순서도 섞음' : ''}`)),
    extra);
}

function backToGallery() {
  S.detail = false;
  renderView();
  window.scrollTo(0, S.galleryY || 0);
}

function viewGallery(run) {
  const cols = S.settings.gcols || 2;
  const cards = run.combos.map((c, i) => {
    const im = c.images.find((x) => x.status === 'done');
    const state = tabState(c);
    const done = c.images.filter((x) => x.status === 'done').length;
    const pic = h('div', { class: `g-pic ${state}`, style: `aspect-ratio:${run.params.width}/${run.params.height}` });
    if (im) {
      const img = h('img', { alt: `조합 ${c.no} 대표 그림`, loading: 'lazy' });
      urlFor(im.id).then((u) => { if (u) img.src = u; });
      pic.append(img);
    } else {
      pic.append(state === 'run' ? h('div', { class: 'spinner' }) : null, h('span', { class: 'cell-label' }, { run: '생성 중', wait: '대기', fail: '실패', done: '중단' }[state]));
    }
    const top = topArtists(namesOf(run, c), c.weights, 2);
    const fv = favOf(run, c);
    if (fv) pic.append(h('span', { class: `g-badge ${rateOf(fv)}` }, `${RATES[rateOf(fv)].icon}`));
    return h('button', { class: 'g-card', onclick: () => { S.galleryY = window.scrollY; S.tab = i; S.detail = true; renderView(); window.scrollTo(0, 0); } },
      pic,
      h('span', { class: 'g-cap' }, h('b', {}, `${c.no}`), kindTag(c), h('span', { class: 'muted' }, ` ${done}/${c.images.length}장`)),
      h('span', { class: 'g-top' }, top.map(([w, n]) => `${n} ${fmt(w)}`).join(' · ')));
  });
  return h('div', { class: 'view' },
    runHead(run, h('div', { class: 'seg', role: 'group', 'aria-label': '한 줄에 보일 조합 수' }, [2, 3, 4].map((n) => h('button', { class: `seg-b${cols === n ? ' on' : ''}`, onclick: () => { S.settings.gcols = n; saveSettings(); renderView(); } }, `${n}`)))),
    h('p', { class: 'muted small' }, '조합마다 첫 그림을 보여 줘요. 누르면 그 조합의 그림을 모두 볼 수 있어요.'),
    h('div', { class: `gallery g${cols}` }, cards));
}

function viewResult() {
  const run = currentRun();
  if (!run) return h('div', { class: 'view' }, h('section', { class: 'card' }, h('h2', {}, '아직 뽑은 조합이 없어요'), h('p', { class: 'muted' }, '뽑기 탭에서 조합을 뽑으면 여기에 조합마다 대표 그림이 나와요.'), h('button', { class: 'btn primary', onclick: () => { S.view = 'make'; renderAll(); } }, '뽑기로 가기')));
  if (S.tab >= run.combos.length) S.tab = 0;
  if (!S.detail) return viewGallery(run);
  const combo = run.combos[S.tab];
  const ci = S.tab;
  const tabs = h('div', { id: 'tabs', class: 'tabs', 'data-run': run.id, role: 'tablist' },
    run.combos.map((c, i) => h('button', { role: 'tab', class: `tab${i === S.tab ? ' on' : ''}`, 'aria-selected': i === S.tab ? 'true' : 'false', 'data-state': tabState(c), onclick: () => setTab(i) },
      h('span', { class: 'dot' }), `${c.no}`, favOf(run, c) ? h('span', { class: `tab-rate ${rateOf(favOf(run, c))}` }, RATES[rateOf(favOf(run, c))].icon) : null)));
  const fav = favOf(run, combo);
  const cols = S.settings.cols || 2;
  const grid = h('div', { class: `cells cols${cols}` }, combo.images.map((_, ii) => registerCell(run, ci, ii)));
  let sx = 0, sy = 0;
  const panel = h('div', { class: 'panel', ontouchstart: (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; },
    ontouchend: (e) => { const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) setTab(S.tab + (dx < 0 ? 1 : -1)); } },
  h('div', { class: 'row between' },
    h('h2', { class: 'combo-title' }, `조합 ${combo.no}`, kindTag(combo)),
    h('div', { class: 'seg', role: 'group', 'aria-label': '한 줄에 보일 그림 수' }, [1, 2, 3].map((n) => h('button', { class: `seg-b${cols === n ? ' on' : ''}`, onclick: () => { S.settings.cols = n; saveSettings(); renderView(); } }, `${n}열`)))),
  rateButtons(fav ? rateOf(fav) : null, (r) => rateCombo(run, combo, r)),
  h('div', { class: 'top small' }, '주도 ', topArtists(namesOf(run, combo), combo.weights).map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])),
  grid,
  h('div', { class: 'row wrap gap6' },
    h('button', { class: 'btn', onclick: () => copy(combo.prompt, '프롬프트') }, '프롬프트 복사'),
    h('button', { class: 'btn', onclick: () => copy(artistLine(namesOf(run, combo), combo.weights, S.settings.space), '작가 블록') }, '작가만 복사'),
    h('button', { class: 'btn', onclick: () => useAsBase(Object.fromEntries(namesOf(run, combo).map((n, i) => [n, combo.weights[i]])), `조합 ${combo.no}`, combo.names) }, '프롬프트에 넣기'),
    h('button', { class: 'btn', onclick: () => moreImages(run, ci) }, `${Math.round(S.settings.perCombo)}장 더 뽑기`)),
  h('details', { class: 'weights' }, h('summary', {}, '가중치 전체 보기'),
    h('pre', {}, namesOf(run, combo).map((n, i) => `${i + 1}. ${fmt(combo.weights[i])}  ${n}`).join('\n'))));
  return h('div', { class: 'view' },
    h('div', { class: 'row between' },
      h('button', { class: 'btn small', onclick: backToGallery }, '← 전체 보기'),
      h('span', { class: 'muted small' }, '옆으로 밀어 조합 넘기기')),
    tabs, panel);
}

// --- history
function runSummary(run) {
  const filled = run.combos.filter((c) => c.images.some((i) => i.status === 'done'));
  const nos = filled.map((c) => c.no);
  const done = run.combos.reduce((x, c) => x + c.images.filter((i) => i.status === 'done').length, 0);
  const left = run.combos.reduce((x, c) => x + c.images.filter((i) => i.status === 'wait' || i.status === 'run').length, 0);
  const lo = Math.min(...nos), hi = Math.max(...nos);
  const range = nos.length ? (lo === hi ? `조합 ${lo}` : `조합 ${lo}~${hi}`) : '아직 그림 없음';
  return { filled, text: `${range}${nos.length ? ` · ${filled.length}조합 · ${done}장` : ''}${left ? ` · 남은 ${left}장` : ''}` };
}

function viewHistory() {
  const v = h('div', { class: 'view' });
  if (!S.runs.length) { v.append(h('section', { class: 'card' }, h('h2', {}, '기록이 없어요'), h('p', { class: 'muted' }, '뽑은 조합은 여기에 날짜별로 쌓여요.'))); return v; }
  for (const run of S.runs) {
    const sum = runSummary(run);
    const thumbs = h('div', { class: 'thumbs' });
    for (const c of sum.filled.slice(0, 4)) {
      const im = c.images.find((i) => i.status === 'done');
      const t = h('div', { class: 'thumb', style: `aspect-ratio:${run.params.width}/${run.params.height}` });
      urlFor(im.id).then((u) => { if (u) t.append(h('img', { src: u, alt: '' })); });
      thumbs.append(t);
    }
    v.append(h('section', { class: `card run${run.id === S.currentRunId ? ' current' : ''}` },
      h('div', { class: 'row between' },
        h('b', { class: 'run-date' }, when(run.created)),
        h('div', { class: 'row gap6' },
          h('button', { class: 'btn small', onclick: () => { S.currentRunId = run.id; S.tab = 0; S.detail = false; S.view = 'result'; renderAll(); window.scrollTo(0, 0); } }, '열기'),
          confirmBtn('삭제', '한 번 더', () => deleteRun(run)))),
      h('div', { class: 'run-line' }, sum.text),
      sum.filled.length ? thumbs : null));
  }
  return v;
}

async function dropImage(id) {
  if (!id) return;
  await store.imageDelete(id).catch(() => {});
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
}

async function deleteRun(run) {
  if (Q.items.some((i) => i.runId === run.id) || (Q.busy && run.combos.some((c) => c.images.some((i) => i.status === 'run' || i.status === 'wait')))) { toast('뽑는 중인 기록은 지울 수 없어요. 먼저 멈춰 주세요.', 'bad'); return; }
  // 평가한 조합의 그림은 즐겨찾기 탭에서 계속 볼 수 있게 남겨 둔다.
  const keep = new Set();
  for (const f of S.favs) {
    const t = favTarget(f);
    if (t && t.run === run) {
      f.imgs = doneImgs(t.combo);
      f.ratio = [run.params.width, run.params.height];
      f.created = f.created || run.created;
      for (const im of f.imgs) keep.add(im.id);
    }
  }
  saveFavs();
  for (const c of run.combos) for (const im of c.images) if (im.id && !keep.has(im.id)) await dropImage(im.id);
  await store.runDelete(run.id).catch(() => {});
  S.runs = S.runs.filter((r) => r !== run);
  if (S.currentRunId === run.id) S.currentRunId = S.runs[0]?.id || null;
  toast(keep.size ? '기록을 지웠어요. 평가한 그림체는 즐겨찾기 탭에 남아 있어요.' : '기록을 지웠어요');
  renderAll();
}

// --- favorites tab: 즐겨찾기 (작은 탭: 애매함 · 싫어요 · 통계)
function favCard(f, list, idx) {
  const rate = rateOf(f);
  const imgs = favImgs(f);
  const [rw, rh] = favRatio(f);
  const names = f.order && f.order.length ? f.order.filter((n) => n in (f.w || {})) : Object.keys(f.w || {});
  const ws = names.map((n) => f.w[n]);
  const t = favTarget(f);
  const strip = h('div', { class: `fav-strip n${Math.min(Math.max(imgs.length, 1), 3)}` });
  if (!imgs.length) strip.append(h('div', { class: 'fav-noimg', style: `aspect-ratio:${rw}/${rh}` }, '그림 없음'));
  imgs.slice(0, 3).forEach((im, ii) => {
    const b = h('button', { class: 'fav-pic', style: `aspect-ratio:${rw}/${rh}`, 'aria-label': `${f.name} 그림 ${ii + 1} 크게 보기`, onclick: () => openViewer(seqFromFavs(list), idx, ii, 'fav') });
    urlFor(im.id).then((u) => { if (u) b.append(h('img', { src: u, alt: '' })); });
    strip.append(b);
  });
  const note = h('textarea', { id: `note-${f.id}`, class: 'note', rows: 3, placeholder: rate === 'meh' ? '어디가 좋고 어디가 별로였는지 (예: 채색은 좋은데 얼굴이 별로)' : '메모 (예: 채색 좋음, 선이 깔끔함)', value: f.note || '',
    oninput: (e) => { if (f.src) setNote(f.src, e.target.value); else { f.note = e.target.value; saveFavs(); } } });
  return h('section', { class: 'card fav' },
    h('div', { class: 'row between' },
      h('div', { class: 'fav-name' }, h('b', {}, f.name), imgs.length > 3 ? h('span', { class: 'muted' }, ` +${imgs.length - 3}장`) : null),
      rate === 'like' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: `pick-${f.id}`, checked: f.pick, onchange: (e) => { f.pick = e.target.checked; saveFavs(); } }), h('span', {}, '흔들기 기준')) : null),
    strip,
    names.length ? h('div', { class: 'top' }, '주도 ', topArtists(names, ws).map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])) : null,
    note,
    rateButtons(rate, (r) => rateFav(f, r)),
    h('div', { class: 'row wrap gap6' },
      t ? h('button', { class: 'btn small', onclick: () => { S.currentRunId = t.run.id; S.tab = t.ci; S.detail = true; S.view = 'result'; renderAll(); window.scrollTo(0, 0); } }, '결과에서 보기') : null,
      names.length ? h('button', { class: 'btn small', onclick: () => useAsBase(f.w, f.name, f.order) }, '프롬프트에 넣기') : null,
      names.length ? h('button', { class: 'btn small', onclick: () => copy(artistLine(names, ws, S.settings.space), '작가 블록') }, '작가만 복사') : null));
}

function viewFavs() {
  const counts = { like: 0, meh: 0, hate: 0 };
  for (const f of S.favs) counts[rateOf(f)]++;
  const tabs = [['like', `★ 즐겨찾기 ${counts.like}`], ['cup', '🏆 월드컵'], ['meh', `애매함 ${counts.meh}`], ['hate', `싫어요 ${counts.hate}`], ['stats', '통계']];
  const sub = h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', {
    role: 'tab', class: `subtab${S.favTab === k ? ' on' : ''}${k === 'like' ? ' main' : ''}`, 'aria-selected': S.favTab === k ? 'true' : 'false',
    onclick: () => { S.favTab = k; renderView(); window.scrollTo(0, 0); } }, label)));
  if (S.favTab === 'stats') return h('div', { class: 'view' }, sub, viewStats());
  if (S.favTab === 'cup') return h('div', { class: 'view' }, sub, viewCup());
  const list = S.favs.filter((f) => rateOf(f) === S.favTab);
  const empty = { like: '결과나 확대 화면에서 ★ 즐겨찾기를 누르면 여기에 모여요.', meh: '애매함을 누른 그림체가 여기에 모여요. 메모에 좋은 점과 아쉬운 점을 적어 두면 통계에 같이 보여요.', hate: '싫어요를 누른 그림체가 여기에 모여요.' }[S.favTab];
  return h('div', { class: 'view' }, sub,
    S.favTab === 'like' ? h('p', { class: 'muted small' }, '"흔들기 기준"을 체크한 즐겨찾기들의 평균이 뽑기 탭 "기준에서 흔들기"의 출발점이 돼요.') : null,
    list.length ? list.map((f, i) => favCard(f, list, i)) : h('section', { class: 'card' }, h('p', { class: 'empty' }, empty)));
}

// 통계: 작가마다 평가별 평균 가중치. 즐겨찾기 +1, 애매함 +0.5, 싫어요 −1.
function computeStats() {
  const rated = S.favs.filter((f) => f.w && Object.keys(f.w).length);
  const all = new Set();
  rated.forEach((f) => Object.keys(f.w).forEach((n) => all.add(n)));
  const rows = [];
  for (const name of all) {
    let lw = 0, lv = 0, mw = 0, mc = 0, hw = 0, hc = 0, aw = 0, ac = 0;
    for (const f of rated) {
      const w = f.w[name];
      if (typeof w !== 'number') continue;
      const r = rateOf(f);
      aw += w; ac++;
      const o = originFactor(f);
      if (r === 'like' || r === 'meh') { const v = RATES[r].value * o; lw += w * v; lv += v; }
      if (r === 'meh') { mw += w; mc++; }
      if (r === 'hate') { hw += w * o; hc += o; }
    }
    const like = lv ? lw / lv : null;
    const meh = mc ? mw / mc : null;
    const hate = hc ? hw / hc : null;
    const base = hate ?? (ac ? aw / ac : S.settings.avg);
    const diff = like == null ? (hate == null ? 0 : -(hate - (ac ? aw / ac : S.settings.avg))) : like - base;
    rows.push({ name, like, meh, hate, diff, n: ac });
  }
  rows.sort((a, b) => b.diff - a.diff);
  return { rows, rated };
}

function statRow(r, max) {
  const pct = max ? Math.min(100, (Math.abs(r.diff) / max) * 50) : 0;
  return h('div', { class: 'stat-row' },
    h('div', { class: 'stat-name' }, r.name),
    h('div', { class: 'stat-bar' }, h('span', { class: `stat-fill ${r.diff >= 0 ? 'pos' : 'neg'}`, style: r.diff >= 0 ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%` })),
    h('div', { class: 'stat-nums' },
      h('span', { class: `stat-diff ${r.diff >= 0 ? 'pos' : 'neg'}` }, `${r.diff >= 0 ? '+' : '−'}${Math.abs(r.diff).toFixed(2)}`),
      h('span', {}, `★ ${r.like == null ? '-' : r.like.toFixed(2)}`),
      h('span', {}, `◐ ${r.meh == null ? '-' : r.meh.toFixed(2)}`),
      h('span', {}, `✕ ${r.hate == null ? '-' : r.hate.toFixed(2)}`)));
}

function viewStats() {
  const counts = { like: 0, meh: 0, hate: 0 };
  for (const f of S.favs) counts[rateOf(f)]++;
  const { rows, rated } = computeStats();
  const box = h('div', { class: 'view' });
  box.append(h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', {}, '평가한 그림체'),
      h('button', { class: 'btn small primary-ish', onclick: () => { S.settings.mode = 'stats'; saveSettings(); S.view = 'make'; renderAll(); window.scrollTo(0, 0); setTimeout(() => document.getElementById('in-mode')?.scrollIntoView({ block: 'center' }), 50); toast('섞기 방식을 "통계 반영"으로 바꿨어요', 'ok'); } }, '통계로 뽑기')),
    h('div', { class: 'stat-counts' },
      h('div', { class: 'stat-count like' }, h('b', {}, String(counts.like)), h('span', {}, '★ 즐겨찾기')),
      h('div', { class: 'stat-count meh' }, h('b', {}, String(counts.meh)), h('span', {}, '◐ 애매함')),
      h('div', { class: 'stat-count hate' }, h('b', {}, String(counts.hate)), h('span', {}, '✕ 싫어요'))),
    h('p', { class: 'muted small' }, '작가마다 "좋게 본 그림체에서의 평균 가중치"에서 "싫어요 그림체에서의 평균 가중치"를 뺀 값이에요. +면 그 작가를 세게 넣을수록 마음에 들었다는 뜻이에요. 즐겨찾기는 1, 애매함은 0.5만큼 반영해요(좋은 점과 아쉬운 점이 섞여 있어서). 통계로 뽑힌 조합의 평가는 한쪽으로 굳지 않게 절반만 반영해요. 싫어요가 없으면 평가한 전체 평균과 비교해요.'),
    rated.length < 10 ? h('p', { class: 'hint' }, `아직 ${rated.length}개라 참고만 하세요. 10개 이상 평가하면 믿을 만해져요.`) : null));
  if (!rows.length) { box.append(h('section', { class: 'card' }, h('p', { class: 'empty' }, '평가한 그림체가 생기면 작가별 통계가 나와요.'))); return box; }
  const arts = artists(segsNow());
  const groups = arts.length ? tasteGroups(arts.map((a) => a.name), arts.map((a) => a.w)) : [];
  if (groups.length) {
    box.append(h('section', { class: 'card' },
      h('h2', {}, `취향 계열 ${groups.length}개`),
      h('p', { class: 'muted small' }, '그림체 탭에서 만든 폴더가 계열 하나씩이 되고, 폴더에 안 넣은 즐겨찾기·애매함은 비슷한 것끼리 자동으로 묶어요. 통계 반영으로 뽑을 때 계열을 돌아가며 출발점으로 써서, 한 가지로 굳지 않게 해요.'),
      groups.map((g, i) => h('div', { class: 'cluster' },
        h('div', { class: 'cluster-head' }, h('b', {}, g.label || `계열 ${i + 1}`), h('span', { class: 'muted' }, ` · ${g.items.length}개`)),
        h('div', { class: 'cluster-members' }, g.items.map((it) => it.name).join(', ')),
        h('div', { class: 'top' }, '주도 ', topArtists(arts.map((a) => a.name), g.center, 3).map(([w, n], j) => [j ? ' · ' : '', h('b', {}, n), ` ${fmt(Math.round(w * 10) / 10)}`]))))));
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.diff)), 0.01);
  const pos = rows.filter((r) => r.diff > 0.005).slice(0, 5);
  const neg = rows.filter((r) => r.diff < -0.005).slice(-5).reverse();
  box.append(h('section', { class: 'card' }, h('h2', {}, '세게 넣을수록 좋았던 작가'), pos.length ? pos.map((r) => statRow(r, max)) : h('p', { class: 'empty' }, '아직 없어요.')));
  box.append(h('section', { class: 'card' }, h('h2', {}, '세게 넣을수록 별로였던 작가'), neg.length ? neg.map((r) => statRow(r, max)) : h('p', { class: 'empty' }, '아직 없어요.')));
  box.append(h('section', { class: 'card' },
    h('details', {}, h('summary', {}, `작가 전체 ${rows.length}명 보기`), h('div', { class: 'stat-list' }, rows.map((r) => statRow(r, max))))));
  const likeMap = Object.fromEntries(rows.filter((r) => r.like != null).map((r) => [r.name, Math.round(r.like * 10) / 10]));
  if (Object.keys(likeMap).length) {
    box.append(h('section', { class: 'card' },
      h('h2', {}, '좋게 본 평균으로 시작하기'),
      h('p', { class: 'muted small' }, '즐겨찾기(1)와 애매함(0.5)의 평균 가중치를 프롬프트에 넣어요. 순서는 그대로 둬요.'),
      h('button', { class: 'btn', onclick: () => useAsBase(likeMap, '좋게 본 평균') }, '프롬프트에 넣기')));
  }
  const mehNotes = S.favs.filter((f) => rateOf(f) === 'meh' && (f.note || '').trim());
  box.append(h('section', { class: 'card' },
    h('h2', {}, '애매함 메모'),
    mehNotes.length ? mehNotes.map((f) => h('div', { class: 'meh-note' }, h('b', {}, f.name), h('p', {}, f.note))) : h('p', { class: 'empty' }, '애매함 그림체에 메모를 남기면 여기에 모여요.')));
  return box;
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
          try { S.sub = await fetchSubscription(S.settings.apiKey); subBox.textContent = subText(S.sub); renderUsage(); } catch (e) { subBox.textContent = e.message; }
        } }, '구독 확인')),
      subBox,
      usageCard()),
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
function subText(s) {
  return `${s.tier}${s.active ? '' : ' (만료)'}${s.usage ? ` · 무료 생성 ${s.usage.percent}% 남음` : ''} · Anlas ${s.anlas ?? '?'}${s.purchased ? ` (구매 ${s.purchased})` : ''}`;
}

// ---------------------------------------------------------------- Opus 무료 생성 한도
let subBusy = false, subErr = '';
async function refreshSub(quiet = true) {
  if (!S.settings.apiKey || subBusy) return;
  subBusy = true;
  renderUsage();
  try {
    S.sub = await fetchSubscription(S.settings.apiKey);
    subErr = '';
  } catch (e) {
    subErr = e.message;
    if (!quiet) toast(e.message, 'bad');
  } finally {
    subBusy = false;
    renderUsage();
    renderStatus();
  }
}

function usageCard() {
  return h('button', { type: 'button', id: 'usage', class: 'usage', onclick: () => refreshSub(false), 'aria-label': 'Opus 무료 생성 한도 (눌러서 새로고침)' });
}

function renderUsage() {
  const st = S.settings;
  const [width, height] = SIZES[st.size] || [832, 1216];
  const free = isFreeForOpus({ width, height, steps: st.steps });
  for (const el of document.querySelectorAll('.usage')) {
    el.innerHTML = '';
    if (!st.apiKey) { el.append(h('span', { class: 'usage-sub' }, '설정 탭에서 API 키를 넣으면 무료 생성 한도가 보여요.')); continue; }
    const s = S.sub;
    if (!s) { el.append(h('span', { class: 'usage-sub' }, subBusy ? '한도를 불러오는 중…' : (subErr || '눌러서 무료 생성 한도 불러오기'))); continue; }
    const t = new Date(s.at);
    const at = `${two(t.getHours())}:${two(t.getMinutes())} 기준`;
    if (s.usage) {
      const p = Math.max(0, Math.min(100, s.usage.percent));
      const level = p <= 10 ? 'low' : p <= 30 ? 'mid' : 'ok';
      el.append(
        h('div', { class: 'usage-head' },
          h('span', { class: 'usage-title' }, 'Opus 무료 생성'),
          h('span', { class: `usage-pct ${level}` }, `${p}%`, h('span', { class: 'usage-left' }, ' 남음'))),
        h('div', { class: 'usage-bar' }, h('span', { class: `usage-fill ${level}`, style: `width:${p}%` })),
        h('div', { class: 'usage-sub' }, `약 ${Math.round(p * IMAGES_PER_PERCENT).toLocaleString('ko-KR')}장 · Anlas ${(s.anlas ?? 0).toLocaleString('ko-KR')} · ${at}${subBusy ? ' · 새로고침 중…' : ''}`),
        h('div', { class: `usage-note ${free ? '' : 'warn'}` }, free
          ? (p > 0 ? '지금 설정은 무료 범위예요. 한도를 다 쓰면 그때부터 Anlas가 들어요.' : '무료 한도를 다 썼어요. 지금 뽑으면 Anlas가 들어요.')
          : '지금 설정(해상도·스텝)은 무료 범위 밖이라 장마다 Anlas가 들어요.'));
    } else {
      el.append(
        h('div', { class: 'usage-head' }, h('span', { class: 'usage-title' }, `${s.tier} · Anlas`), h('span', { class: 'usage-pct ok' }, (s.anlas ?? 0).toLocaleString('ko-KR'))),
        h('div', { class: 'usage-sub' }, `무료 생성 한도 정보가 없는 구독이에요 · ${at}`));
    }
  }
}

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

// ================================================================ v2: 그림체 탭 · 월드컵 · 폴더 · 합치기
// 그림체 하나 = 조합 하나. 키(src)는 `${회차id}:${조합번호}`.

const saveMeta = () => store.kvSet('styleMeta', S.meta).catch(() => {});
const saveFolders = () => store.kvSet('folders', S.folders).catch(() => {});
const saveCups = () => store.kvSet('cups', S.cups).catch(() => {});
const favBySrc = (src) => S.favs.find((f) => f.src === src);
const metaOf = (src) => (S.meta[src] ||= {});

function noteOf(src) { return favBySrc(src)?.note ?? S.meta[src]?.note ?? ''; }
function setNote(src, text) {
  const f = favBySrc(src);
  if (f) { f.note = text; saveFavs(); }
  metaOf(src).note = text;
  saveMeta();
}
const folderOf = (src) => S.folders.find((x) => x.id === S.meta[src]?.folder) || null;

function comboTitle(c) { return c.kind === 'merge' ? `합성 ${c.mergeLabel || c.no}` : `조합 ${c.no}`; }

// src → 그림체 정보 (회차가 남아 있으면 회차에서, 지웠으면 평가에 보관된 것에서)
function styleOf(src) {
  const [runId, no] = String(src).split(':');
  const run = runById(runId);
  if (run) {
    const ci = run.combos.findIndex((c) => String(c.no) === no);
    if (ci >= 0) {
      const c = run.combos[ci];
      return { src, run, ci, combo: c, no: c.no, title: comboTitle(c), imgs: doneImgs(c), names: namesOf(run, c), weights: c.weights, created: run.created, ratio: [run.params.width, run.params.height] };
    }
  }
  const f = favBySrc(src);
  if (f && f.w) {
    const names = f.order && f.order.length ? f.order.filter((n) => n in f.w) : Object.keys(f.w);
    return { src, fav: f, no: f.name.replace(/^(조합|합성)\s*/, ''), title: f.name, imgs: f.imgs || [], names, weights: names.map((n) => f.w[n]), created: f.created || 0, ratio: f.ratio || [832, 1216] };
  }
  return null;
}

function allStyles() {
  const out = [];
  const seen = new Set();
  for (const run of S.runs) {
    run.combos.forEach((c, ci) => {
      const imgs = doneImgs(c);
      if (!imgs.length) return;
      const src = favKey(run, c);
      seen.add(src);
      out.push({ src, run, ci, combo: c, no: c.no, title: comboTitle(c), imgs, names: namesOf(run, c), weights: c.weights, created: run.created, ratio: [run.params.width, run.params.height] });
    });
  }
  for (const f of S.favs) {
    if (!f.src || seen.has(f.src) || !(f.imgs || []).length) continue;
    const st = styleOf(f.src);
    if (st) out.push(st);
  }
  return out;
}
const seqItemOfStyle = (st) => (st.run ? { runId: st.run.id, ci: st.ci } : { fav: st.fav });
const weightMap = (st) => Object.fromEntries(st.names.map((n, i) => [n, st.weights[i]]));

// 월드컵에서 받은 가장 좋은 등수 (없으면 null)
function bestRank(src) {
  let best = null;
  for (const c of S.cups) if (c.done) for (const r of c.ranking) if (r.src === src && (best == null || r.rank < best)) best = r.rank;
  return best;
}
const rankLabel = (r) => (r === 1 ? '1위' : r === 2 ? '2위' : `${(r - 1) * 2}강`);

// ---------------------------------------------------------------- 그림체 탭
const SORTS = [['new', '최신순'], ['old', '오래된순'], ['cupBest', '월드컵 높은 순'], ['cupWorst', '월드컵 낮은 순'], ['rate', '즐겨찾기순']];
const RATE_ORDER = { like: 0, meh: 1, none: 2, hate: 3 };

function filteredStyles() {
  const st = S.settings;
  let list = allStyles();
  const f = st.styleFilter || 'all';
  if (f === 'like' || f === 'meh' || f === 'hate') list = list.filter((s) => { const v = favBySrc(s.src); return v && rateOf(v) === f; });
  else if (f === 'none') list = list.filter((s) => !favBySrc(s.src));
  else if (f === 'nofolder') list = list.filter((s) => !folderOf(s.src));
  else if (f.startsWith('folder:')) list = list.filter((s) => S.meta[s.src]?.folder === f.slice(7));
  const key = (s) => s.created * 1000 + (Number(s.no) || 0);
  const rk = (s) => bestRank(s.src);
  const rate = (s) => { const v = favBySrc(s.src); return RATE_ORDER[v ? rateOf(v) : 'none']; };
  const sort = st.styleSort || 'new';
  list.sort((a, b) => {
    if (sort === 'old') return key(a) - key(b);
    if (sort === 'cupBest' || sort === 'cupWorst') {
      const ra = rk(a), rb = rk(b);
      if (ra == null && rb == null) return key(b) - key(a);
      if (ra == null) return 1;
      if (rb == null) return -1;
      return sort === 'cupBest' ? ra - rb : rb - ra;
    }
    if (sort === 'rate') return rate(a) - rate(b) || key(b) - key(a);
    return key(b) - key(a);
  });
  return list;
}

function styleBadges(s) {
  const v = favBySrc(s.src);
  const r = bestRank(s.src);
  const fd = folderOf(s.src);
  return [
    v ? h('span', { class: `chip ${rateOf(v)}` }, RATES[rateOf(v)].icon) : null,
    r != null ? h('span', { class: 'chip cup' }, `🏆 ${rankLabel(r)}`) : null,
    fd ? h('span', { class: 'chip folder' }, `📁 ${fd.name}`) : null,
  ];
}

function viewStyles() {
  const st = S.settings;
  const list = filteredStyles();
  const total = allStyles().length;
  const limit = S.styleLimit || 60;
  const cols = st.styleCols || 2;
  const filters = [['all', '전체'], ['like', '★'], ['meh', '◐ 애매'], ['hate', '✕ 싫어'], ['none', '평가 없음'], ...S.folders.map((x) => [`folder:${x.id}`, `📁 ${x.name}`]), ['nofolder', '폴더 없음']];
  const sortSel = h('select', { id: 'in-styleSort', onchange: (e) => { st.styleSort = e.target.value; saveSettings(); S.styleLimit = 60; renderView(); } }, SORTS.map(([v, l]) => h('option', { value: v }, l)));
  sortSel.value = st.styleSort || 'new';
  const folderName = h('input', { type: 'text', id: 'folder-name', placeholder: '새 폴더 이름 (예: 수채 느낌)' });
  const cards = list.slice(0, limit).map((s, idx) => {
    const pic = h('div', { class: 'g-pic', style: `aspect-ratio:${s.ratio[0]}/${s.ratio[1]}` });
    urlFor(s.imgs[0].id).then((u) => { if (u) pic.append(h('img', { src: u, alt: '', loading: 'lazy' })); });
    const sel = S.settings.merge || {};
    const tag = sel.a === s.src ? 'A' : sel.b === s.src ? 'B' : '';
    if (tag) pic.append(h('span', { class: 'merge-tag' }, tag));
    return h('button', { class: 'g-card', onclick: () => openSheet(s.src, list) },
      pic,
      h('span', { class: 'g-cap' }, h('b', {}, s.title)),
      h('span', { class: 'chips' }, styleBadges(s)));
  });
  return h('div', { class: 'view' },
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, `그림체 ${list.length}${list.length !== total ? ` / ${total}` : ''}개`),
        h('div', { class: 'seg', role: 'group', 'aria-label': '한 줄에 보일 그림체 수' }, [2, 3].map((n) => h('button', { class: `seg-b${cols === n ? ' on' : ''}`, onclick: () => { st.styleCols = n; saveSettings(); renderView(); } }, `${n}열`)))),
      field('정렬', sortSel),
      h('div', { class: 'filter-chips' }, filters.map(([v, l]) => h('button', { class: `fchip${(st.styleFilter || 'all') === v ? ' on' : ''}`, onclick: () => { st.styleFilter = v; saveSettings(); S.styleLimit = 60; renderView(); } }, l))),
      h('details', {}, h('summary', {}, `폴더 관리 (${S.folders.length}개)`),
        h('p', { class: 'muted small' }, '비슷한 그림체끼리 폴더로 묶어 두면, 통계 반영으로 뽑을 때 폴더 하나가 취향 계열 하나가 돼요.'),
        h('div', { class: 'row gap6' }, folderName, h('button', { class: 'btn small', style: 'flex:0 0 auto', onclick: () => {
          const name = folderName.value.trim();
          if (!name) { toast('폴더 이름을 넣어 주세요', 'bad'); return; }
          S.folders.push({ id: `d${Date.now()}`, name }); saveFolders(); renderView(); toast(`"${name}" 폴더를 만들었어요`, 'ok');
        } }, '만들기')),
        h('div', { class: 'order-list' }, S.folders.map((x) => {
          const cnt = Object.values(S.meta).filter((m) => m.folder === x.id).length;
          const nm = h('input', { type: 'text', id: `fd-${x.id}`, value: x.name, onchange: (e) => { x.name = e.target.value.trim() || x.name; saveFolders(); renderView(); } });
          return h('div', { class: 'order-row' }, h('div', { class: 'folder-edit' }, nm, h('span', { class: 'muted small' }, `${cnt}개`)),
            confirmBtn('삭제', '한 번 더', () => { for (const m of Object.values(S.meta)) if (m.folder === x.id) delete m.folder; S.folders = S.folders.filter((y) => y !== x); saveFolders(); saveMeta(); renderView(); }));
        })))),
    mergeCard(),
    list.length ? h('div', { class: `gallery g${cols}` }, cards) : h('section', { class: 'card' }, h('p', { class: 'empty' }, total ? '이 조건에 맞는 그림체가 없어요.' : '아직 그림이 나온 조합이 없어요. 뽑기 탭에서 뽑아 보세요.')),
    list.length > limit ? h('button', { class: 'btn wide', onclick: () => { S.styleLimit = limit + 60; renderView(); } }, `더 보기 (${list.length - limit}개 남음)`) : null);
}

// ---------------------------------------------------------------- 그림체 상세 (아래에서 올라오는 시트)
const SH = { open: false, src: null, list: [] };
function openSheet(src, list) { Object.assign(SH, { open: true, src, list }); renderSheet(); }
function closeSheet() { SH.open = false; renderSheet(); }

function renderSheet() {
  const root = document.getElementById('sheet');
  root.innerHTML = '';
  root.hidden = !SH.open;
  document.body.classList.toggle('sheet-open', SH.open);
  if (!SH.open) return;
  const s = styleOf(SH.src);
  if (!s) { closeSheet(); return; }
  const v = favBySrc(s.src);
  const strip = h('div', { class: `fav-strip n${Math.min(Math.max(s.imgs.length, 1), 3)}` });
  const seq = SH.list.map(seqItemOfStyle);
  const si = Math.max(0, SH.list.findIndex((x) => x.src === s.src));
  s.imgs.slice(0, 3).forEach((im, ii) => {
    const b = h('button', { class: 'fav-pic', style: `aspect-ratio:${s.ratio[0]}/${s.ratio[1]}`, onclick: () => openViewer(seq.length ? seq : [seqItemOfStyle(s)], seq.length ? si : 0, ii, 'styles') });
    urlFor(im.id).then((u) => { if (u) b.append(h('img', { src: u, alt: '' })); });
    strip.append(b);
  });
  const fsel = h('select', { id: 'sheet-folder', onchange: (e) => { const m = metaOf(s.src); if (e.target.value) m.folder = e.target.value; else delete m.folder; saveMeta(); renderView(); renderSheet(); } },
    h('option', { value: '' }, '폴더 없음'), S.folders.map((x) => h('option', { value: x.id }, x.name)));
  fsel.value = S.meta[s.src]?.folder || '';
  const note = h('textarea', { id: 'sheet-note', class: 'note', rows: 4, placeholder: '이 그림체에 대한 메모', value: noteOf(s.src), oninput: (e) => setNote(s.src, e.target.value) });
  const doRate = (r) => { if (s.run) rateCombo(s.run, s.combo, r); else rateFav(s.fav, r); renderSheet(); };
  const merge = S.settings.merge || {};
  root.append(
    h('div', { class: 'sheet-back', onclick: closeSheet }),
    h('div', { class: 'sheet-panel', role: 'dialog', 'aria-label': s.title },
      h('div', { class: 'row between' }, h('div', { class: 'sheet-title' }, s.title, kindTag(s.combo || {})), h('button', { class: 'btn small ghost', onclick: closeSheet }, '닫기')),
      h('div', { class: 'chips' }, styleBadges(s)),
      strip,
      h('div', { class: 'top' }, '주도 ', topArtists(s.names, s.weights).map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])),
      rateButtons(v ? rateOf(v) : null, doRate),
      field('폴더', fsel),
      field('메모', note),
      h('div', { class: 'row wrap gap6' },
        h('button', { class: `btn small${merge.a === s.src ? ' on-a' : ''}`, onclick: () => setMergeSlot('a', s.src) }, '합치기 A로'),
        h('button', { class: `btn small${merge.b === s.src ? ' on-b' : ''}`, onclick: () => setMergeSlot('b', s.src) }, '합치기 B로'),
        s.run ? h('button', { class: 'btn small', onclick: () => { closeSheet(); S.currentRunId = s.run.id; S.tab = s.ci; S.detail = true; S.view = 'result'; renderAll(); window.scrollTo(0, 0); } }, '결과에서 보기') : null,
        h('button', { class: 'btn small', onclick: () => { closeSheet(); useAsBase(weightMap(s), s.title, s.names); } }, '프롬프트에 넣기'),
        h('button', { class: 'btn small', onclick: () => copy(artistLine(s.names, s.weights, S.settings.space), '작가 블록') }, '작가만 복사'))));
}

// ---------------------------------------------------------------- 합치기
function setMergeSlot(slot, src) {
  const m = (S.settings.merge ||= { ratio: 50 });
  m[slot] = src;
  if (slot === 'a' && m.b === src) m.b = null;
  if (slot === 'b' && m.a === src) m.a = null;
  saveSettings();
  toast(`${styleOf(src)?.title || '그림체'}를 ${slot.toUpperCase()}에 넣었어요`, 'ok');
  renderSheet();
  renderView();
}

// A·B 가중치를 비율대로 섞는다. 지금 프롬프트의 작가 기준, 한쪽에 없는 작가는 프롬프트 값. 순서는 A를 따른다.
function mergePlan() {
  const m = S.settings.merge || {};
  const A = m.a && styleOf(m.a), B = m.b && styleOf(m.b);
  if (!A || !B) return null;
  const segs = segsNow();
  const arts = artists(segs);
  if (!arts.length) return null;
  const r = Math.max(0, Math.min(100, Number(m.ratio ?? 50))) / 100;
  const wa = weightMap(A), wb = weightMap(B);
  const w = arts.map((a) => Math.round(((typeof wa[a.name] === 'number' ? wa[a.name] : a.w) * r + (typeof wb[a.name] === 'number' ? wb[a.name] : a.w) * (1 - r)) * 10) / 10);
  const order = orderByNames(arts, A.names);
  return { A, B, r, segs, arts, order, names: order.map((i) => arts[i].name), weights: order.map((i) => w[i]) };
}

function mergeCard() {
  const m = S.settings.merge || { ratio: 50 };
  const slot = (key) => {
    const s = m[key] && styleOf(m[key]);
    const box = h('div', { class: `merge-slot ${key}` });
    if (!s) { box.append(h('span', { class: 'muted small' }, `${key.toUpperCase()}: 아래에서 그림체를 눌러 "합치기 ${key.toUpperCase()}로"`)); return box; }
    const pic = h('div', { class: 'merge-pic', style: `aspect-ratio:${s.ratio[0]}/${s.ratio[1]}` });
    if (s.imgs[0]) urlFor(s.imgs[0].id).then((u) => { if (u) pic.append(h('img', { src: u, alt: '' })); });
    box.append(h('span', { class: 'merge-key' }, key.toUpperCase()), pic, h('b', {}, s.title));
    return box;
  };
  const plan = mergePlan();
  const ratio = h('input', { type: 'range', id: 'merge-ratio', min: 0, max: 100, step: 10, value: m.ratio ?? 50,
    oninput: (e) => { (S.settings.merge ||= {}).ratio = Number(e.target.value); saveSettings(); const l = document.getElementById('merge-ratio-label'); if (l) l.textContent = `A ${e.target.value} : B ${100 - e.target.value}`; } ,
    onchange: () => renderView() });
  const k = Math.max(1, Math.min(10, Math.round(S.settings.perCombo)));
  return h('section', { class: 'card merge' },
    h('details', { open: Boolean(m.a || m.b) || undefined }, h('summary', {}, '두 그림체 합치기'),
      h('div', { class: 'merge-slots' }, slot('a'), slot('b')),
      h('div', { class: 'row between' }, h('span', { id: 'merge-ratio-label', class: 'merge-ratio' }, `A ${m.ratio ?? 50} : B ${100 - (m.ratio ?? 50)}`),
        (m.a || m.b) ? h('button', { class: 'btn small ghost', onclick: () => { S.settings.merge = { ratio: m.ratio ?? 50 }; saveSettings(); renderView(); } }, '비우기') : null),
      ratio,
      plan ? h('div', { class: 'top' }, '합친 결과 주도 ', topArtists(plan.names, plan.weights).map(([w, n], i) => [i ? ' · ' : '', h('b', {}, n), ` ${fmt(w)}`])) : null,
      h('div', { class: 'row wrap gap6' },
        h('button', { class: 'btn', disabled: !plan, onclick: () => { const p = mergePlan(); if (p) useAsBase(Object.fromEntries(p.names.map((n, i) => [n, p.weights[i]])), `합성 ${p.A.no}+${p.B.no}`, p.names); } }, '프롬프트에 넣기'),
        h('button', { class: 'btn primary', disabled: !plan, onclick: runMerge }, `${k}장 바로 뽑기`))));
}

function runMerge() {
  const p = mergePlan();
  if (!p) return;
  if (!S.settings.apiKey.trim()) { toast('설정(⚙)에서 NovelAI API 키를 먼저 넣어 주세요.', 'bad'); return; }
  const k = Math.max(1, Math.min(10, Math.round(S.settings.perCombo)));
  S.counter++;
  store.kvSet('counter', S.counter).catch(() => {});
  const combo = {
    no: S.counter, kind: 'merge', mergeOf: [p.A.src, p.B.src], ratio: Math.round(p.r * 100), mergeLabel: `${p.A.no}+${p.B.no}`,
    names: p.names, weights: p.weights, prompt: build(reorder(p.segs, p.order), p.weights, { space: S.settings.space }),
    images: Array.from({ length: k }, () => ({ seed: randomSeed(), status: 'wait', id: null, error: '' })),
  };
  createRun([combo], { mode: 'merge', seedMode: 'diff', names: p.arts.map((a) => a.name) });
}

// ---------------------------------------------------------------- 이상형 월드컵 (통계에는 반영하지 않는다)
const cupEntrants = () => S.favs.filter((f) => rateOf(f) === 'like' && f.src && (styleOf(f.src)?.imgs.length)).map((f) => f.src);
const activeCup = () => S.cups.find((c) => !c.done);
const roundName = (n) => (n === 2 ? '결승' : n === 4 ? '4강' : `${n}강`);

function startCup(srcs, label) {
  if (srcs.length < 2) { toast('그림이 있는 즐겨찾기가 2개 이상 있어야 해요.', 'bad'); return; }
  const list = shuffledOrder(srcs.length).map((i) => srcs[i]);
  let P = 2;
  while (P < list.length) P *= 2;
  const byes = P - list.length;
  const round = [];
  let k = 0;
  for (let i = 0; i < P / 2; i++) {
    if (i < byes) round.push(list[k++], null);
    else round.push(list[k++], list[k++]);
  }
  const cup = { id: `c${Date.now()}`, created: Date.now(), label, entrants: list, round, next: [], mi: 0, size: P, out: {}, done: false, ranking: [] };
  S.cups.unshift(cup);
  S.cupOut = false;
  skipByes(cup);
  saveCups();
  S.favTab = 'cup';
  renderView();
  window.scrollTo(0, 0);
}

function skipByes(cup) {
  while (cup.mi * 2 < cup.round.length) {
    const a = cup.round[cup.mi * 2], b = cup.round[cup.mi * 2 + 1];
    if (a && b) return;
    cup.next.push(a || b);
    cup.mi++;
  }
  finishRound(cup);
}

function finishRound(cup) {
  if (cup.next.length === 1) {
    cup.out[cup.next[0]] = 1;
    cup.done = true;
    cup.ranking = Object.entries(cup.out).map(([src, rank]) => ({ src, rank })).sort((x, y) => x.rank - y.rank);
    cup.round = []; cup.next = [];
    toast('월드컵이 끝났어요. 결과가 저장됐어요.', 'ok');
    return;
  }
  cup.round = cup.next;
  cup.next = [];
  cup.mi = 0;
  cup.size = cup.round.length;
  skipByes(cup);
}

function pickCup(cup, side) {
  const a = cup.round[cup.mi * 2], b = cup.round[cup.mi * 2 + 1];
  const win = side === 0 ? a : b, lose = side === 0 ? b : a;
  cup.out[lose] = cup.size / 2 + 1;
  cup.next.push(win);
  cup.mi++;
  if (cup.mi * 2 >= cup.round.length) finishRound(cup); else skipByes(cup);
  saveCups();
  renderView();
  window.scrollTo(0, 0);
}

const cupPick = {};  // 대전 화면에서 각 그림체가 지금 보여 주는 그림 번호
// 월드컵 대전 화면은 화면 전체를 쓴다. 폰을 세로로 들면 위아래, 가로로 들면 좌우가 보통 더 크게 보인다.
function cupLayout(ratio) {
  const pref = S.settings.cupLayout || 'auto';
  if (pref !== 'auto') return pref;
  const W = window.innerWidth, H = window.innerHeight - 70;
  const r = ratio[0] / ratio[1];
  const row = Math.min(W / 2, H * r);
  const col = Math.min(W, (H / 2) * r);
  return row >= col ? 'row' : 'col';
}

function cupSide(cup, src, side) {
  const s = styleOf(src);
  if (!s) return h('div', { class: 'cupfs-side' }, h('p', { class: 'empty' }, '그림체를 찾지 못했어요'));
  const n = s.imgs.length;
  const i = ((cupPick[src] || 0) % n + n) % n;
  const img = h('img', { alt: `${s.title} 그림 ${i + 1}` });
  urlFor(s.imgs[i].id).then((u) => { if (u) img.src = u; });
  const flip = (d) => (e) => { e.stopPropagation(); cupPick[src] = i + d; renderView(); };
  return h('div', { class: `cupfs-side s${side}` },
    h('button', { class: 'cupfs-pic', 'aria-label': `${s.title} 크게 보기`, onclick: () => openViewer([seqItemOfStyle(s)], 0, i, 'cup') }, img),
    h('div', { class: 'cupfs-name' }, s.title, n > 1 ? h('span', { class: 'cupfs-count' }, ` ${i + 1}/${n}`) : null),
    n > 1 ? h('button', { class: 'cupfs-flip left', onclick: flip(-1), 'aria-label': '이전 그림' }, '‹') : null,
    n > 1 ? h('button', { class: 'cupfs-flip right', onclick: flip(1), 'aria-label': '다음 그림' }, '›') : null,
    h('button', { class: 'cupfs-pick', onclick: () => pickCup(cup, side) }, '이걸로 ✓'));
}

function cupFull(cup) {
  const a = cup.round[cup.mi * 2], b = cup.round[cup.mi * 2 + 1];
  const matches = cup.round.length / 2;
  const ratio = (styleOf(a) || styleOf(b))?.ratio || [832, 1216];
  const layout = cupLayout(ratio);
  return h('div', { class: `cupfs ${layout}`, role: 'dialog', 'aria-label': '이상형 월드컵' },
    h('div', { class: 'cupfs-top' },
      h('button', { class: 'btn small ghost', onclick: () => { S.cupOut = true; renderView(); } }, '나가기'),
      h('div', { class: 'cupfs-title' }, h('b', {}, roundName(cup.size)), h('span', {}, ` ${cup.mi + 1} / ${matches}`)),
      h('button', { class: 'btn small ghost', onclick: () => { S.settings.cupLayout = layout === 'row' ? 'col' : 'row'; saveSettings(); renderView(); } }, layout === 'row' ? '위아래로' : '좌우로')),
    h('div', { class: 'cupfs-vs' }, cupSide(cup, a, 0), h('div', { class: 'cupfs-vsmark' }, 'VS'), cupSide(cup, b, 1)));
}

function cupResult(cup) {
  const groups = new Map();
  for (const r of cup.ranking) { if (!groups.has(r.rank)) groups.set(r.rank, []); groups.get(r.rank).push(r.src); }
  const champ = styleOf(cup.ranking[0]?.src);
  const topN = h('input', { type: 'number', id: `top-${cup.id}`, inputmode: 'numeric', min: 2, value: Math.min(8, cup.ranking.length), class: 'topn' });
  return h('section', { class: 'card' },
    h('div', { class: 'row between' },
      h('div', {}, h('b', { class: 'run-date' }, when(cup.created)), h('span', { class: 'muted' }, ` · ${cup.label} · ${cup.ranking.length}개`)),
      confirmBtn('삭제', '한 번 더', () => { S.cups = S.cups.filter((x) => x !== cup); saveCups(); renderView(); })),
    champ ? h('div', { class: 'run-line' }, '🏆 우승 ', h('b', {}, champ.title)) : null,
    h('details', {}, h('summary', {}, '등수 전체 보기'),
      [...groups.entries()].map(([rank, srcs]) => h('div', { class: 'rank-group' },
        h('div', { class: 'rank-label' }, rank === 3 ? '4강 (공동 3위)' : rankLabel(rank)),
        h('div', { class: 'thumbs' }, srcs.map((src) => {
          const s = styleOf(src);
          const t = h('button', { class: 'thumb rank-thumb', style: s ? `aspect-ratio:${s.ratio[0]}/${s.ratio[1]}` : '', onclick: () => s && openSheet(src, srcs.map(styleOf).filter(Boolean)) }, h('span', { class: 'rank-name' }, s ? s.title : '지운 그림체'));
          if (s?.imgs[0]) urlFor(s.imgs[0].id).then((u) => { if (u) t.prepend(h('img', { src: u, alt: '' })); });
          return t;
        }))))),
    h('div', { class: 'row wrap gap6' },
      h('span', {}, '상위'), topN, h('span', {}, '위 이상으로'),
      h('button', { class: 'btn small', onclick: () => {
        const n = parseInt(topN.value, 10);
        const srcs = cup.ranking.filter((r) => r.rank <= n && styleOf(r.src)).map((r) => r.src);
        if (srcs.length < 2) { toast('2개 이상이어야 다시 대전할 수 있어요.', 'bad'); return; }
        if (activeCup()) { toast('진행 중인 월드컵을 먼저 끝내거나 그만둬 주세요.', 'bad'); return; }
        startCup(srcs, `${cup.label} 상위 ${n}위 재대전`);
      } }, '다시 대전')));
}

function viewCup() {
  const cup = activeCup();
  const box = h('div', { class: 'view' });
  if (cup) {
    if (!S.cupOut) { box.append(cupFull(cup)); return box; }
    box.append(h('section', { class: 'card' },
      h('h2', {}, `진행 중: ${roundName(cup.size)} ${cup.mi + 1} / ${cup.round.length / 2} 경기`),
      h('p', { class: 'muted small' }, `${cup.label} · 월드컵 결과는 통계에 들어가지 않아요.`),
      h('button', { class: 'btn primary wide', onclick: () => { S.cupOut = false; renderView(); } }, '이어하기'),
      confirmBtn('이번 월드컵 그만두기', '한 번 더 누르면 지워져요', () => { S.cups = S.cups.filter((x) => x !== cup); saveCups(); renderView(); }, 'btn ghost danger')));
    return box;
  }
  const entrants = cupEntrants();
  const n = entrants.length;
  box.append(h('section', { class: 'card' },
    h('h2', {}, '이상형 월드컵'),
    h('p', { class: 'muted small' }, `그림이 있는 즐겨찾기 ${n}개로 해요. 크기를 고르면 그만큼 무작위로 뽑고, "전체"는 모두 넣어요(남는 자리는 부전승). 결과는 등수별로 남고, 통계에는 반영하지 않아요.`),
    h('div', { class: 'cup-sizes' },
      [4, 8, 16, 32, 64].map((k) => h('button', { class: 'btn', disabled: n < k, onclick: () => startCup(shuffledOrder(n).slice(0, k).map((i) => entrants[i]), `${k}강`) }, `${k}강`)),
      h('button', { class: 'btn primary', disabled: n < 2, onclick: () => startCup(entrants, `전체 ${n}개`) }, `전체 ${n}개`))));
  const done = S.cups.filter((c) => c.done);
  if (done.length) box.append(h('h2', { class: 'section-title' }, '지난 결과'), ...done.map(cupResult));
  return box;
}

// ---------------------------------------------------------------- 폴더 = 취향 계열 (통계 반영)
// 폴더가 있으면 폴더 하나를 계열 하나로 쓴다(평가 없는 그림체도 넣고, 싫어요는 뺀다).
// 폴더에 안 넣은 즐겨찾기·애매함은 지금처럼 자동으로 묶는다.
function tasteGroups(names, fallback) {
  const groups = [];
  const inFolder = new Set();
  for (const fd of S.folders) {
    const items = [];
    for (const [src, m] of Object.entries(S.meta)) {
      if (m.folder !== fd.id) continue;
      const s = styleOf(src);
      if (!s) continue;
      const v = favBySrc(src);
      if (v && rateOf(v) === 'hate') continue;
      inFolder.add(src);
      const wm = weightMap(s);
      const wt = (v ? RATES[rateOf(v)].value * originFactor(v) : (s.combo?.kind === 'stats' ? 0.5 : 1));
      items.push({ name: s.title, v: names.map((n, i) => (typeof wm[n] === 'number' ? wm[n] : fallback[i])), wt });
    }
    if (!items.length) continue;
    const tw = items.reduce((x, it) => x + it.wt, 0);
    groups.push({ label: `📁 ${fd.name}`, items, weight: tw, center: names.map((_, i) => items.reduce((x, it) => x + it.v[i] * it.wt, 0) / tw) });
  }
  const auto = tasteClusters(names, fallback, inFolder);
  auto.forEach((g, i) => { g.label = `자동 계열 ${i + 1}`; g.items = g.items.map((it) => ({ ...it, name: it.f.name })); });
  return [...groups, ...auto];
}

// ---------------------------------------------------------------- 두 번째 모드: 상황 뽑기 (틀만)
const SCENE_VIEWS = [['scene-list', '상황'], ['scene-make', '뽑기'], ['scene-result', '결과']];
function viewScene() {
  const soon = h('span', { class: 'soon' }, '준비 중');
  const pages = {
    'scene-list': [
      h('section', { class: 'card scene-hero' },
        h('div', { class: 'row between' }, h('h2', {}, '상황 프롬프트 모음'), soon),
        h('p', { class: 'muted' }, '자주 쓰는 상황(장면·구도·의상·표정) 프롬프트를 모아 두는 곳이에요. 상황마다 이름·태그·메모를 붙여 저장해요.')),
      h('section', { class: 'card' }, h('h2', {}, '저장한 상황'), h('p', { class: 'empty' }, '아직 상황이 없어요.'), h('button', { class: 'btn', disabled: true }, '+ 상황 추가'))],
    'scene-make': [
      h('section', { class: 'card scene-hero' },
        h('div', { class: 'row between' }, h('h2', {}, '여러 상황 한 번에 뽑기'), soon),
        h('p', { class: 'muted' }, '작가 셔플에서 만든 그림체(즐겨찾기·폴더)를 하나 고르고, 상황 여러 개를 골라 한꺼번에 뽑아요.')),
      h('section', { class: 'card' }, h('h2', {}, '1. 그림체 고르기'), h('p', { class: 'empty' }, '그림체 탭의 즐겨찾기·폴더에서 가져올 예정이에요.')),
      h('section', { class: 'card' }, h('h2', {}, '2. 상황 고르기'), h('p', { class: 'empty' }, '상황 탭에서 저장한 상황을 여러 개 고를 예정이에요.')),
      h('button', { class: 'btn primary wide', disabled: true }, '뽑기 (준비 중)')],
    'scene-result': [
      h('section', { class: 'card scene-hero' },
        h('div', { class: 'row between' }, h('h2', {}, '상황별 결과'), soon),
        h('p', { class: 'muted' }, '상황마다 탭으로 나뉘어 결과가 쌓일 예정이에요.'))],
  };
  return h('div', { class: 'view' }, pages[S.sceneView] || pages['scene-list']);
}

// ---------------------------------------------------------------- ≡ 메뉴
const APPS = [
  { id: 'shuffle', title: '작가 셔플', desc: '그림체 탐색 · 뽑기 · 결과 · 기록 · 즐겨찾기 · 그림체', icon: '🎨' },
  { id: 'scene', title: '상황 뽑기', desc: '상황 프롬프트 모음 · 그림체로 여러 상황 뽑기', icon: '🎬', soon: true },
];
const D = { open: false };
function openDrawer() { D.open = true; renderDrawer(); }
function closeDrawer() { D.open = false; renderDrawer(); }
function switchApp(id) {
  S.app = id;
  store.kvSet('app', id).catch(() => {});
  document.documentElement.dataset.app = id;
  closeDrawer();
  renderAll();
  window.scrollTo(0, 0);
}
function renderDrawer() {
  const root = document.getElementById('drawer');
  root.innerHTML = '';
  root.hidden = !D.open;
  if (!D.open) return;
  root.append(
    h('div', { class: 'drawer-back', onclick: closeDrawer }),
    h('nav', { class: 'drawer-panel', 'aria-label': '기능 메뉴' },
      h('div', { class: 'drawer-head' }, h('img', { src: 'icon-192.png', alt: '', width: 34, height: 34 }), h('b', {}, 'NAI 작가 셔플')),
      APPS.map((a) => h('button', { class: `drawer-item${S.app === a.id ? ' on' : ''}`, onclick: () => switchApp(a.id) },
        h('span', { class: 'drawer-icon' }, a.icon),
        h('span', { class: 'drawer-text' }, h('b', {}, a.title, a.soon ? h('span', { class: 'soon' }, '준비 중') : null), h('span', { class: 'muted small' }, a.desc)))),
      h('div', { class: 'drawer-sep' }),
      h('button', { class: 'drawer-item', onclick: () => { closeDrawer(); S.app = 'shuffle'; document.documentElement.dataset.app = 'shuffle'; S.view = 'settings'; renderAll(); window.scrollTo(0, 0); } },
        h('span', { class: 'drawer-icon' }, '⚙'), h('span', { class: 'drawer-text' }, h('b', {}, '설정'), h('span', { class: 'muted small' }, 'API 키 · 생성 설정 · 업데이트')))));
}

function renderAppbar() {
  const bar = document.getElementById('appbar');
  bar.innerHTML = '';
  const app = APPS.find((a) => a.id === S.app) || APPS[0];
  bar.append(
    h('button', { class: 'icon-btn', onclick: openDrawer, 'aria-label': '메뉴 열기' }, '☰'),
    h('span', { class: 'appbar-title' }, app.title),
    h('button', { class: `icon-btn${S.view === 'settings' && S.app === 'shuffle' ? ' on' : ''}`, 'aria-label': '설정', onclick: () => { S.app = 'shuffle'; document.documentElement.dataset.app = 'shuffle'; S.view = S.view === 'settings' ? 'make' : 'settings'; renderAll(); window.scrollTo(0, 0); } }, '⚙'));
}

// ---------------------------------------------------------------- frame
const VIEWS = [['make', '뽑기'], ['result', '결과'], ['history', '기록'], ['fav', '즐겨찾기'], ['styles', '그림체']];

function renderStatus() {
  const bar = document.getElementById('status');
  bar.innerHTML = '';
  bar.hidden = !Q.busy;
  if (Q.busy) {
    const wait = Q.waitUntil ? ` · ${Math.max(0, Math.ceil((Q.waitUntil - Date.now()) / 1000))}초 뒤 다시 시도` : '';
    bar.append(
      h('div', { class: 'status-bar', style: `--p:${Q.total ? (Q.done / Q.total) * 100 : 0}%` }),
      h('div', { class: 'status-row' },
        h('span', {}, `뽑는 중 ${Q.done}/${Q.total}${wait}${S.sub?.usage ? ` · 무료 ${S.sub.usage.percent}%` : ''}`),
        h('button', { class: 'btn small ghost', onclick: () => { if (native) { Gen.genCancel().then(syncNative).catch(() => {}); } else Q.cancel = true; toast('지금 그림까지만 뽑고 멈춰요'); } }, '멈추기')));
  }
  renderMakeButton();
}

function renderView() {
  const main = document.getElementById('main');
  const y = window.scrollY;
  main.innerHTML = '';
  const fn = S.app === 'scene' ? viewScene : { make: viewMake, result: viewResult, history: viewHistory, fav: viewFavs, styles: viewStyles, settings: viewSettings }[S.view];
  main.append(fn());
  window.scrollTo(0, S.app === 'shuffle' && (S.view === 'result' || S.view === 'fav' || S.view === 'styles') ? y : 0);
  if (S.view === 'result' && S.detail) centerActiveTab();
  document.body.classList.toggle('cup-full', Boolean(main.querySelector('.cupfs')));
  renderUsage();
  if (S.view === 'settings') store.usage().then((u) => { const el = document.getElementById('usage-box'); if (el && u != null) el.textContent = `폰에 저장된 그림·기록: 약 ${(u / 1048576).toFixed(0)}MB`; });
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  if (S.app === 'scene') {
    nav.style.gridTemplateColumns = `repeat(${SCENE_VIEWS.length}, 1fr)`;
    for (const [id, label] of SCENE_VIEWS) nav.append(h('button', { class: `nav-b${S.sceneView === id ? ' on' : ''}`, onclick: () => { S.sceneView = id; renderAll(); window.scrollTo(0, 0); } }, label));
    return;
  }
  nav.style.gridTemplateColumns = `repeat(${VIEWS.length}, 1fr)`;
  for (const [id, label] of VIEWS) {
    nav.append(h('button', { class: `nav-b${S.view === id ? ' on' : ''}`, 'aria-current': S.view === id ? 'page' : null,
      onclick: () => { const same = S.view === id; if (same && id === 'result') S.detail = false; if (id === 'fav' && !same) S.favTab = 'like'; S.view = id; renderAll(); if (!same) window.scrollTo(0, 0); } }, label,
    id === 'result' && Q.busy ? h('span', { class: 'nav-dot' }) : null));
  }
}

function renderAll() {
  renderAppbar();
  renderNav();
  renderView();
  renderStatus();
}

onBackButton(() => {
  if (V.open) { closeViewer(); return; }
  if (D.open) { closeDrawer(); return; }
  if (S.view === 'fav' && S.favTab === 'cup' && activeCup() && !S.cupOut) { S.cupOut = true; renderView(); return; }
  if (SH.open) { closeSheet(); return; }
  if (S.app === 'scene') { switchApp('shuffle'); return; }
  if (S.view === 'result' && S.detail) { backToGallery(); return; }
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
  // 테스트용: 브라우저 미리보기에서 ?mock 이면 가짜 그림·가짜 구독 정보를 쓴다.
  if (!native && /[?&]mock\b/.test(location.search)) window.__mock = true;
  try {
    await load();
  } catch (e) {
    toast(`저장된 데이터를 읽지 못했어요: ${e?.message || e}`, 'bad');
  }
  document.getElementById('boot')?.remove();
  renderAll();
  startNativeSync();
  refreshSub();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (S.sub?.at || 0) > 60000) refreshSub(); });
  // 테스트용: 브라우저 미리보기에서 ?mock 이면 가짜 그림을 만든다.

})();
