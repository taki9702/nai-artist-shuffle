// NovelAI 요청: 그림 한 장과 구독 정보. 요청 형식은 NAI Style Lab(모바일/PC)과 같다.
import { http, bodyText } from './platform.js';
import { pngFromResponse } from './zip.js';

export const NAI_GEN_URL = 'https://image.novelai.net/ai/generate-image';
export const NAI_SUB_URL = 'https://image.novelai.net/user/subscription';
export const MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full'];
export const SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2m_sde'];
export const SIZES = { '세로 832×1216': [832, 1216], '정방형 1024×1024': [1024, 1024], '가로 1216×832': [1216, 832] };
export const MAX_SEED = 4294967295;
export const RETRY_STATUSES = [429, 500, 502, 503, 504];
export const RETRY_DELAYS = [5, 15, 45];
export const AUTH_STATUSES = [401, 403];

// novelai.net이 직접 보내는 값(V5, 품질 태그·UC 프리셋 없음). 웹에 그림을 불러가도 같은 결과가 나온다.
const WEB_PARAMS = {
  ucPresetId: 'none', qualityPresetId: 'none', autoSmea: false, dynamic_thresholding: false,
  controlnet_strength: 1, legacy: false, add_original_image: true, legacy_v3_extend: false,
  use_coords: false, normalize_reference_strength_multiple: true, inpaintImg2ImgStrength: 1,
  straight_alpha: true, tag_hint_qt: 0, tag_hint_uc_preset: 0, deliberate_euler_ancestral_bug: false,
  prefer_brownian: true, noise_schedule: 'karras',
};

export class NaiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const randomSeed = () => Math.floor(Math.random() * MAX_SEED);

export function buildPayload({ prompt, negative, charPrompt, charNegative, model, width, height, steps, cfg, rescale, sampler }, seed) {
  const caption = String(prompt || '').trim();
  if (!caption) throw new Error('프롬프트가 비어 있습니다.');
  const cp = String(charPrompt || '').trim();
  const cn = String(charNegative || '').trim();
  const neg = String(negative || '').trim();
  const chars = cp ? [[cp, cn]] : [];
  const center = { x: 0.5, y: 0.5 };
  const parameters = {
    params_version: 4, width, height, scale: cfg, sampler, steps, seed, n_samples: 1, cfg_rescale: rescale, ...WEB_PARAMS,
    v4_prompt: { caption: { base_caption: caption, char_captions: chars.map(([c]) => ({ char_caption: c, centers: [center] })) },
      use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { base_caption: neg, char_captions: chars.map(([, n]) => ({ char_caption: n, centers: [center] })) } },
    negative_prompt: neg,
    characterPrompts: chars.map(([c, n]) => ({ prompt: c, uc: n, center, enabled: true })),
  };
  return { input: caption, model, action: 'generate', parameters };
}

export function naiHeaders(apiKey) {
  return {
    'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey || '').trim()}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://novelai.net/', Origin: 'https://novelai.net', Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9',
  };
}

const STATUS_TEXT = {
  400: '요청이 거부되었습니다. 프롬프트나 설정 값을 확인해 주세요.',
  401: 'API 키가 만료되었거나 올바르지 않습니다.',
  402: 'Anlas가 부족하거나 구독이 필요합니다.',
  403: '이 작업을 할 권한이 없습니다. 구독 상태를 확인해 주세요.',
  429: '요청이 너무 많습니다. 잠시 후 다시 시도합니다.',
  500: 'NovelAI 서버 오류입니다.',
  502: 'NovelAI 서버가 응답하지 않습니다.',
  503: 'NovelAI 서버가 바쁩니다.',
  504: 'NovelAI 서버 응답 시간이 초과되었습니다.',
};

export async function generateImage(params, seed) {
  const payload = buildPayload(params, seed);
  if (globalThis.__mock) return mockPng(params, seed);
  let res;
  try {
    res = await http({ url: NAI_GEN_URL, method: 'POST', headers: naiHeaders(params.apiKey), json: payload, responseType: 'bytes', timeout: 120000 });
  } catch (error) {
    throw new Error(`NovelAI에 연결하지 못했습니다: ${error?.message || error}`);
  }
  if (res.status !== 200) {
    throw new NaiHttpError(res.status, `${STATUS_TEXT[res.status] || `HTTP ${res.status}`} (${bodyText(res.data).slice(0, 160)})`);
  }
  return pngFromResponse(res.data);
}

export async function fetchSubscription(apiKey) {
  if (globalThis.__mock) return { tier: 'Opus', tierNum: 3, active: true, anlas: 9930, fixed: 9898, purchased: 32, usage: { percent: 80, negative: false }, at: Date.now() };
  let res;
  try {
    res = await http({ url: NAI_SUB_URL, method: 'GET', headers: naiHeaders(apiKey), responseType: 'json', timeout: 10000 });
  } catch {
    throw new Error('NovelAI에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.');
  }
  if (res.status !== 200) throw new Error(STATUS_TEXT[res.status] || `HTTP ${res.status}`);
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (!data || typeof data !== 'object' || !('tier' in data)) throw new Error('구독 정보를 읽지 못했습니다.');
  const tier = { 0: 'Free', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' }[data.tier] ?? `Tier ${data.tier}`;
  let anlas = null;
  const s = data.trainingStepsLeft;
  if (s && Number.isInteger(s.fixedTrainingStepsLeft) && Number.isInteger(s.purchasedTrainingSteps)) anlas = s.fixedTrainingStepsLeft + s.purchasedTrainingSteps;
  // Opus 무료 생성 한도(배터리): usage.percent = 남은 %. 다 쓰면 그때부터 Anlas가 든다.
  const u = data.usage;
  const usage = u && typeof u.percent === 'number' ? { percent: u.percent, negative: Boolean(u.isNegative) } : null;
  const fixed = Number.isInteger(s?.fixedTrainingStepsLeft) ? s.fixedTrainingStepsLeft : null;
  const purchased = Number.isInteger(s?.purchasedTrainingSteps) ? s.purchasedTrainingSteps : null;
  return { tier, tierNum: data.tier, active: Boolean(data.active), anlas, fixed, purchased, usage, at: Date.now() };
}

// Opus는 1MP 이하·28스텝 이하·1장이면 Anlas가 들지 않는다.
// NovelAI 화면 기준 1%는 약 17.3장(80% ≈ 1384장, 14.3% ≈ 247장). 해상도에 따라 다를 수 있어 '약'으로만 보여 준다.
export const IMAGES_PER_PERCENT = 17.3;

export function isFreeForOpus({ width, height, steps }) {
  return width * height <= 1024 * 1024 && steps <= 28;
}

// 브라우저 미리보기 시험용 가짜 그림 (?mock). 폰 앱에서는 쓰이지 않는다.
async function mockPng(params, seed) {
  await new Promise((r) => setTimeout(r, 400));
  if (globalThis.__mockFail && Math.random() < 0.3) throw new NaiHttpError(500, 'NovelAI 서버 오류입니다. (mock)');
  const c = document.createElement('canvas');
  c.width = params.width / 8; c.height = params.height / 8;
  const g = c.getContext('2d');
  const hue = (seed % 360);
  g.fillStyle = `hsl(${hue} 50% 30%)`; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(String(seed).slice(0, 6), 8, 24);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// ================================================================ 상황 뽑기 (NAI 화면과 같은 설정으로 한 장씩)
// novelai.net V5 화면의 선택지. 품질 태그·UC 프리셋 문구는 서버가 붙여 주지 않아서 앱이 직접 붙인다.
export const SCENE_MODELS = [
  ['nai-diffusion-5-full', 'NAI Diffusion V5 Full'],
  ['nai-diffusion-5-curated', 'NAI Diffusion V5 Curated'],
  ['nai-diffusion-4-5-full', 'NAI Diffusion V4.5 Full'],
  ['nai-diffusion-4-5-curated', 'NAI Diffusion V4.5 Curated'],
  ['nai-diffusion-4-full', 'NAI Diffusion V4 Full'],
];
export const SCENE_SIZES = [
  ['normal-portrait', '노말 세로', 832, 1216], ['normal-landscape', '노말 가로', 1216, 832], ['normal-square', '노말 정사각', 1024, 1024],
  ['small-portrait', '작게 세로', 512, 768], ['small-landscape', '작게 가로', 768, 512], ['small-square', '작게 정사각', 640, 640],
  ['large-portrait', '크게 세로', 1024, 1536], ['large-landscape', '크게 가로', 1536, 1024], ['large-square', '크게 정사각', 1472, 1472],
  ['wall-portrait', '배경화면 세로', 1088, 1920], ['wall-landscape', '배경화면 가로', 1920, 1088],
  ['pixiv-header', '픽시브 헤더', 1408, 704],
];
export const SCENE_SAMPLERS = [
  ['k_euler_ancestral', 'Euler Ancestral'], ['k_dpmpp_2m', 'DPM++ 2M'], ['k_euler', 'Euler'], ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
  ['k_dpmpp_sde', 'DPM++ SDE'], ['k_dpm_2', 'DPM2'], ['k_dpm_fast', 'DPM Fast'], ['ddim_v3', 'DDIM'],
];
export const NOISE_SCHEDULES = [['karras', 'karras'], ['exponential', 'exponential'], ['polyexponential', 'polyexponential']];
export const QUALITY_PRESETS = [['none', '끄기'], ['standard', 'Standard'], ['light', 'Light']];
export const UC_PRESETS = [['none', '없음'], ['heavy', 'Heavy'], ['light', 'Light'], ['human', 'Human Focus']];
const QUALITY_TEXT = { standard: ', very aesthetic, masterpiece, no text', light: ', very aesthetic, amazing quality, no text' };
const UC_HEAVY = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const UC_TEXT = {
  heavy: UC_HEAVY,
  light: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
  human: `${UC_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy`,
};
const HINT = { none: 0, standard: 1, heavy: 2, light: 3, human: 4 };

export const isV5Full = (model) => model === 'nai-diffusion-5-full';
export const sceneSize = (s) => {
  if (s.size === 'custom') return [Number(s.width) || 832, Number(s.height) || 1216];
  const p = SCENE_SIZES.find(([k]) => k === s.size);
  return p ? [p[2], p[3]] : [832, 1216];
};
// Medium Effort(V5 Full 전용)는 NAI 화면처럼 14스텝·Euler Ancestral 고정, UC 프리셋·리스케일 없음.
export function sceneEffective(s) {
  const medium = isV5Full(s.model) && s.effort === 'medium';
  const [width, height] = sceneSize(s);
  return {
    medium, width, height,
    model: medium ? 'nai-diffusion-5-full-medium' : s.model,
    steps: medium ? 14 : Math.max(1, Math.min(50, Math.round(Number(s.steps) || 23))),
    sampler: medium ? 'k_euler_ancestral' : s.sampler,
    scale: Number(s.scale) || 5,
    rescale: medium ? 0 : Number(s.rescale) || 0,
    quality: isV5Full(s.model) ? s.quality : 'none',
    ucPreset: isV5Full(s.model) && !medium ? s.ucPreset : 'none',
  };
}

// s: 상황 뽑기 설정(프롬프트·UC·캐릭터·설정). 캐릭터는 켜진 것만 보낸다.
export function buildScenePayload(s, seed) {
  const e = sceneEffective(s);
  const base = String(s.prompt || '').trim();
  if (!base) throw new Error('프롬프트가 비어 있어요.');
  const input = base + (QUALITY_TEXT[e.quality] || '');
  const userUc = String(s.negative || '').trim();
  const negative = [UC_TEXT[e.ucPreset], userUc].filter(Boolean).join(', ');
  const custom = s.posMode === 'custom';
  const chars = (s.chars || []).filter((c) => c.enabled !== false && String(c.prompt || '').trim())
    .map((c) => ({ prompt: String(c.prompt).trim(), uc: String(c.uc || '').trim(), center: custom && c.pos ? { x: c.pos.x, y: c.pos.y } : { x: 0.5, y: 0.5 } }));
  const useCoords = custom && chars.length > 0;
  const parameters = {
    params_version: 4, width: e.width, height: e.height, scale: e.scale, sampler: e.sampler, steps: e.steps, seed, n_samples: 1, cfg_rescale: e.rescale,
    ...WEB_PARAMS,
    noise_schedule: s.noise || 'karras',
    ucPresetId: e.ucPreset, qualityPresetId: e.quality, tag_hint_qt: HINT[e.quality] || 0, tag_hint_uc_preset: HINT[e.ucPreset] || 0,
    use_coords: useCoords,
    v4_prompt: { caption: { base_caption: input, char_captions: chars.map((c) => ({ char_caption: c.prompt, centers: [c.center] })) }, use_coords: useCoords, use_order: true },
    v4_negative_prompt: { caption: { base_caption: negative, char_captions: chars.map((c) => ({ char_caption: c.uc, centers: [c.center] })) }, use_coords: useCoords, use_order: true },
    negative_prompt: negative,
    characterPrompts: chars.map((c) => ({ prompt: c.prompt, uc: c.uc, center: c.center, enabled: true })),
  };
  return { input, model: e.model, action: 'generate', parameters };
}

// 다 만든 요청 본문을 그대로 보낸다 (브라우저 미리보기·생성 서비스가 없을 때).
export async function generatePayload(payload, apiKey) {
  if (globalThis.__mock) {
    const p = payload.parameters;
    return mockPng({ width: p.width, height: p.height }, p.seed);
  }
  let res;
  try {
    res = await http({ url: NAI_GEN_URL, method: 'POST', headers: naiHeaders(apiKey), json: payload, responseType: 'bytes', timeout: 120000 });
  } catch (error) {
    throw new Error(`NovelAI에 연결하지 못했습니다: ${error?.message || error}`);
  }
  if (res.status !== 200) throw new NaiHttpError(res.status, `${STATUS_TEXT[res.status] || `HTTP ${res.status}`} (${bodyText(res.data).slice(0, 160)})`);
  return pngFromResponse(res.data);
}
