// NAI 작가 셔플: 프롬프트 속 작가 가중치를 섞어 조합을 만들고, 조합마다 그림을 뽑아 탭으로 비교한다.
import { VERSION, REPO } from './version.js';
import { DEFAULT_SETTINGS, DEFAULT_FAVS } from './defaults.js';
import { parse, artists, build, artistLine, shuffleWeights, topArtists, fmt, reorder, orderByNames, shuffledOrder } from './shuffle.js';
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
  orders: [],
  counter: 0,
  view: 'make',
  runs: [],
  currentRunId: null,
  tab: 0,
  favTab: 'like',
  detail: false,  // 결과 탭: false = 갤러리(조합마다 대표 그림), true = 조합 하나 크게
  sub: null,
};
const urls = new Map();  // 그림 id -> object URL

async function load() {
  const [settings, locks, favs, counter, orders] = await Promise.all([store.kvGet('settings'), store.kvGet('locks'), store.kvGet('favs'), store.kvGet('counter'), store.kvGet('orders')]);
  S.orders = Array.isArray(orders) ? orders : [];
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
function statsPlan(arts) {
  const { rows, rated } = computeStats();
  if (!rated.length) return null;
  const st = S.settings;
  const k = (STRENGTH[st.statStrength] || STRENGTH.mid)[1];
  const by = new Map(rows.map((r) => [r.name, r]));
  const centers = arts.map((a) => {
    if (S.locks[a.name]) return a.w;
    const r = by.get(a.name);
    if (!r) return a.w;
    const start = r.like ?? a.w;
    return Math.min(st.max, Math.max(st.min, start + k * r.diff));
  });
  return { centers, rated: rated.length };
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

const KIND = { stats: '통계', explore: '탐색' };
const kindTag = (c) => (c.kind ? h('span', { class: `kind ${c.kind}` }, KIND[c.kind]) : null);
const MODE_LABEL = { random: '완전 무작위', vary: '기준에서 흔들기', stats: '통계 반영' };

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
  if (st.mode === 'stats') {
    const plan = statsPlan(arts);
    if (!plan) { toast('평가한 그림체가 없어서 통계를 반영할 수 없어요. 먼저 즐겨찾기·애매함·싫어요를 눌러 주세요.', 'bad'); return; }
    base = plan.centers;
    hates = st.avoidHate ? S.favs.filter((f) => rateOf(f) === 'hate' && f.w) : [];
  }
  const [width, height] = SIZES[st.size] || [832, 1216];
  const n = Math.max(1, Math.round(st.combos) || 1);
  const k = Math.max(1, Math.min(10, Math.round(st.perCombo)));
  const fixed = Number.parseInt(String(st.fixedSeed).trim(), 10);
  const sharedSeeds = Array.from({ length: k }, (_, i) => (st.seedMode === 'fixed' && Number.isFinite(fixed) ? (fixed + i) : randomSeed()));
  const combos = [];
  for (let c = 0; c < n; c++) {
    let w, kind = '';
    if (st.mode === 'stats') {
      // 일부는 탐색용 완전 무작위, 나머지는 통계 출발점에서 흔들기. 싫어요와 너무 비슷하면 다시 만든다.
      const explore = Math.random() * 100 < (Number(st.explore) || 0);
      kind = explore ? 'explore' : 'stats';
      for (let t = 0; t < 40; t++) {
        w = explore
          ? shuffleWeights(arts.map((a) => a.w), locked, { ...st, mode: 'random' })
          : shuffleWeights(base, locked, { ...st, mode: 'vary' });
        if (!w || !tooCloseToHate(names, w, hates)) break;
      }
    } else w = shuffleWeights(base, locked, st);
    if (!w) { toast('잠근 작가 때문에 평균을 맞출 수 없어요. 범위를 넓혀 주세요.', 'bad'); return; }
    S.counter++;
    const seeds = st.seedMode === 'diff' ? Array.from({ length: k }, randomSeed) : sharedSeeds;
    const images = seeds.map((seed) => ({ seed, status: 'wait', id: null, error: '' }));
    if (st.shuffleOrder) {
      const order = shuffledOrder(names.length);
      const cw = order.map((i) => w[i]);
      combos.push({ no: S.counter, kind, names: order.map((i) => names[i]), weights: cw, prompt: build(reorder(segs, order), cw, { space: st.space }), images });
    } else {
      combos.push({ no: S.counter, kind, weights: w, prompt: build(segs, w, { space: st.space }), images });
    }
  }
  store.kvSet('counter', S.counter).catch(() => {});
  const run = {
    id: `r${Date.now()}`, created: Date.now(), names, combos,
    mode: st.mode, seedMode: st.seedMode, shuffleOrder: Boolean(st.shuffleOrder),
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
      id: `f${Date.now()}`, src: favKey(run, combo), name: `조합 ${combo.no}`, note: '', pick: false, rate,
      order: names.slice(), w: Object.fromEntries(names.map((n, i) => [n, combo.weights[i]])),
      imgs: doneImgs(combo), ratio: [run.params.width, run.params.height], created: Date.now(),
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
  return { no: combo.no, title: `조합 ${combo.no}`, imgs: doneImgs(combo), rate: fav ? rateOf(fav) : null, run, combo, ratio: [run.params.width, run.params.height], names: namesOf(run, combo), weights: combo.weights, created: run.created };
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
      ? `평가 ${rated}개의 통계에서 출발해요. 좋았던 작가는 올리고 별로였던 작가는 내려요(반영 강도: ${(STRENGTH[st.statStrength] || STRENGTH.mid)[0]}). ±${st.jitter}씩 흔들고, ${st.explore}%는 탐색용 완전 무작위로 뽑아요.${st.avoidHate ? ' 싫어요와 너무 비슷한 조합은 다시 만들어요.' : ''} 평균은 ${st.avg}로 맞춰요.`
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
        h('label', { class: 'check span2' }, h('input', { type: 'checkbox', id: 'in-shuffleOrder', checked: st.shuffleOrder, onchange: (e) => { S.settings.shuffleOrder = e.target.checked; saveSettings(); } }), h('span', {}, '조합마다 작가 순서도 섞기')),
        field('시드', select('seedMode', [['same', '조합끼리 같은 시드'], ['diff', '매번 다른 시드'], ['fixed', '시드 직접 지정']], renderShuffleHint)),
        h('div', { id: 'fixed-field' }, field('시작 시드', h('input', { type: 'number', id: 'in-fixedSeed', inputmode: 'numeric', value: st.fixedSeed, oninput: (e) => { S.settings.fixedSeed = e.target.value; saveSettings(); } }), '장마다 1씩 늘려요'))),
      h('p', { id: 'shuffle-hint', class: 'hint' }),
      h('p', { class: 'muted small' }, '"조합끼리 같은 시드"는 모든 조합이 같은 시드 세트를 써서 그림체 차이만 비교돼요. "기준에서 흔들기"의 기준은 즐겨찾기 탭에서 "흔들기 기준"을 체크해 골라요.')),
    h('div', { class: 'sticky-go' }, makeBtn));
  setTimeout(() => { renderArtistList(artistBox); renderOrders(); renderShuffleHint(); renderMakeButton(); }, 0);
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
    oninput: (e) => { f.note = e.target.value; saveFavs(); } });
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
  const tabs = [['like', `★ 즐겨찾기 ${counts.like}`], ['meh', `애매함 ${counts.meh}`], ['hate', `싫어요 ${counts.hate}`], ['stats', '통계']];
  const sub = h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', {
    role: 'tab', class: `subtab${S.favTab === k ? ' on' : ''}${k === 'like' ? ' main' : ''}`, 'aria-selected': S.favTab === k ? 'true' : 'false',
    onclick: () => { S.favTab = k; renderView(); window.scrollTo(0, 0); } }, label)));
  if (S.favTab === 'stats') return h('div', { class: 'view' }, sub, viewStats());
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
      if (r === 'like' || r === 'meh') { const v = RATES[r].value; lw += w * v; lv += v; }
      if (r === 'meh') { mw += w; mc++; }
      if (r === 'hate') { hw += w; hc++; }
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
    h('p', { class: 'muted small' }, '작가마다 "좋게 본 그림체에서의 평균 가중치"에서 "싫어요 그림체에서의 평균 가중치"를 뺀 값이에요. +면 그 작가를 세게 넣을수록 마음에 들었다는 뜻이에요. 즐겨찾기는 1, 애매함은 0.5만큼 반영해요(좋은 점과 아쉬운 점이 섞여 있어서). 싫어요가 없으면 평가한 전체 평균과 비교해요.'),
    rated.length < 10 ? h('p', { class: 'hint' }, `아직 ${rated.length}개라 참고만 하세요. 10개 이상 평가하면 믿을 만해져요.`) : null));
  if (!rows.length) { box.append(h('section', { class: 'card' }, h('p', { class: 'empty' }, '평가한 그림체가 생기면 작가별 통계가 나와요.'))); return box; }
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
const VIEWS = [['make', '뽑기'], ['result', '결과'], ['history', '기록'], ['fav', '즐겨찾기'], ['settings', '설정']];

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
  const fn = { make: viewMake, result: viewResult, history: viewHistory, fav: viewFavs, settings: viewSettings }[S.view];
  main.append(fn());
  window.scrollTo(0, S.view === 'result' || S.view === 'fav' ? y : 0);
  if (S.view === 'result' && S.detail) centerActiveTab();
  if (S.view === 'settings') store.usage().then((u) => { const el = document.getElementById('usage-box'); if (el && u != null) el.textContent = `폰에 저장된 그림·기록: 약 ${(u / 1048576).toFixed(0)}MB`; });
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const [id, label] of VIEWS) {
    nav.append(h('button', { class: `nav-b${S.view === id ? ' on' : ''}`, 'aria-current': S.view === id ? 'page' : null,
      onclick: () => { const same = S.view === id; if (same && id === 'result') S.detail = false; if (id === 'fav' && !same) S.favTab = 'like'; S.view = id; renderAll(); if (!same) window.scrollTo(0, 0); } }, label,
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
