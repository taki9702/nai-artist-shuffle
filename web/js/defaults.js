// 처음 켰을 때 채워 둘 값. 사용자가 바꾸면 폰에 저장된 값이 쓰인다.

export const DEFAULT_PROMPT = `1.2::artist:channel_(caststation) ::,
1.5::artist:na tarapisu153 ::,
1.5::artist:aengdohwa ::,
0.5::artist:xipa ::,
0.8::artist:aisutabetao ::,
0.5::artist:akakura ::,
1.2::artist:asdkd123 ::,
1.0::artist:au (d elete) ::,
0.4::artist:aya (lezon) ::,
1.3::artist:azz0422 ::,
0.4::artist:binxngchng1 ::,
0.2::artist:chokopaii ::,
0.3::artist:chyan ::,
1.3::artist:cierra (ra-bit) ::,
0.7::artist:dogs (dlrkdejr26) ::,
0.5::artist:dryegen ::,
1.1::artist:ebora ::,
0.3::artist:fagi (kakikaki) ::,
0.7::artist:fine 9725 ::,
1.4::artist:jnt ::,
0.7::artist:john kafka ::,
0.6::artist:k pring ::,
0.5::artist:kafun ::,
0.6::artist:jnkku ::,

year 2026, year 2025, detailed skin texture, ultra detailed, high detail, detailed eyes, silky skin, masterpiece, best quality, very aesthetic, highres, best illustration, novel illustration, sharp lineart, clean lines, cell shading, high contrast, hard shading, hard edges, cinematic lighting, dramatic shadows, -1::flat color::, 1.3::blurry edges::,  aegyo sal, nsfw,

cold blue lighting, rim light,
intense cold blue light illumination, highlighted by cold blue light,
cold blue illumination on face and hair,
cold blue tint,
strong cold blue ambient light,

1girl, solo, 0.3::simple background::,`;

export const DEFAULT_NEGATIVE = 'official art, logo, watermark, too many watermarks, blank page, text-only page, reference, username, signature, artist:xinzoruo, artist:milkpanda, artist collaboration, variant set, large variant set, 4koma, 2koma, toon (style), oekaki, turnaround, distorted, disfigured, artistic error, distorted anatomy, anatomical structure error, asymmetrical face, unnatural hair, cloudy eyes, blank eyes, pointy ears, bad proportions, bad limb, bad hands, extra hands, bad hand structure, extra digits, fewer digits, bad legs, extra legs, amputee, distorted composition, bad perspective, negative space, animation error, chromatic aberration, disorganized colors, scan artifacts, jpeg artifacts, vertical lines, vertical banding, worst quality, bad quality, lowres, upscaled, fewer details, unfinished, incomplete, amateur, cheesy, bad eyes, unsatisfactory, inadequate, deficient, subpar, poor, displeasing, very displeasing, bad illustration, bad portrait, dark nipples, 3d, blender (medium), realistic, missing finger, extra arms, long neck, bad feet, mutation, bad face, deformed face, white border, outline border, letterboxed, framed, blurry face, censored';

export const DEFAULT_SETTINGS = {
  apiKey: '',
  prompt: DEFAULT_PROMPT,
  negative: DEFAULT_NEGATIVE,
  charPrompt: '',
  charNegative: '',
  model: 'nai-diffusion-5-full',
  size: '세로 832×1216',
  steps: 28,
  cfg: 5,
  rescale: 0.2,
  sampler: 'k_euler_ancestral',
  mode: 'random',
  avg: 0.8,
  min: 0.2,
  max: 1.6,
  jitter: 0.3,
  combos: 5,
  perCombo: 3,
  seedMode: 'same',
  fixedSeed: '',
  space: true,
  cols: 2,
};

const W = (pairs) => Object.fromEntries(pairs);
const NAMES = ['channel_(caststation)', 'na tarapisu153', 'aengdohwa', 'xipa', 'aisutabetao', 'akakura', 'asdkd123', 'au (d elete)', 'aya (lezon)', 'azz0422', 'binxngchng1', 'chokopaii', 'chyan', 'cierra (ra-bit)', 'dogs (dlrkdejr26)', 'dryegen', 'ebora', 'fagi (kakikaki)', 'fine 9725', 'jnt', 'john kafka', 'k pring', 'kafun', 'jnkku'];
const zip = (ws) => W(NAMES.map((n, i) => [n, ws[i]]));

export const DEFAULT_FAVS = [
  { id: 'seed-4', name: '조합 4', note: '낫배드. 채색이 좋음, 야한 느낌', pick: true,
    w: zip([1.2, 1.5, 1.5, 0.5, 0.8, 0.5, 1.2, 1.0, 0.4, 1.3, 0.4, 0.2, 0.3, 1.3, 0.7, 0.5, 1.1, 0.3, 0.7, 1.4, 0.7, 0.6, 0.5, 0.6]) },
  { id: 'seed-7', name: '조합 7', note: '느낌 좋음', pick: false,
    w: zip([1.2, 1.0, 0.7, 0.3, 1.4, 0.9, 0.5, 0.6, 0.5, 0.6, 1.2, 1.1, 0.4, 1.6, 1.0, 0.6, 1.3, 0.7, 0.5, 0.4, 1.0, 1.0, 0.2, 0.5]) },
  { id: 'seed-8', name: '조합 8', note: '야한 느낌, 4번과 같은 채색', pick: true,
    w: zip([0.9, 1.4, 0.3, 0.4, 1.0, 1.1, 0.9, 0.7, 0.5, 1.0, 1.2, 0.3, 0.6, 1.5, 0.8, 0.5, 0.7, 0.3, 1.2, 0.3, 1.6, 0.3, 1.3, 0.4]) },
];
