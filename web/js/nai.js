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
  return { tier, tierNum: data.tier, active: Boolean(data.active), anlas };
}

// Opus는 1MP 이하·28스텝 이하·1장이면 Anlas가 들지 않는다.
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
