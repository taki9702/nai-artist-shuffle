// 프롬프트 안의 artist: 태그를 찾아 가중치만 바꾼다. 다른 태그와 순서, 줄바꿈은 그대로 둔다.

const ART = /^(\s*)(?:(-?\d*\.?\d+)\s*::\s*)?(artist:[^:]+?)\s*(?:::)?(\s*)$/i;

// 쉼표로 나눈 조각들. 작가 조각은 {art, lead, w, name, trail}, 나머지는 {raw}.
export function parse(text) {
  const parts = String(text || '').split(',');
  return parts.map((p, i) => {
    const last = i === parts.length - 1;
    const m = p.match(ART);
    if (m && m[3].replace(/^artist:\s*/i, '').trim()) {
      return { art: true, lead: m[1], w: m[2] !== undefined ? parseFloat(m[2]) : 1, name: m[3].trim().replace(/^artist:\s*/i, ''), trail: m[4], last };
    }
    return { art: false, raw: p, last };
  });
}

export const artists = (segs) => segs.filter((s) => s.art);

export const fmt = (x) => {
  const r = Math.round(x * 100) / 100;
  return Math.abs(r * 10 - Math.round(r * 10)) < 1e-9 ? r.toFixed(1) : r.toFixed(2);
};

// weights: 작가 순서대로의 가중치. oneLine: 이어진 작가 블록을 한 줄로. space: `::` 앞 공백.
export function build(segs, weights, { oneLine = false, space = true } = {}) {
  const sp = space ? ' ' : '';
  let out = '';
  let ai = 0;
  segs.forEach((s, i) => {
    let piece;
    if (s.art) {
      const tag = `${fmt(weights[ai++])}::artist:${s.name}${sp}::`;
      if (oneLine) {
        const prev = segs[i - 1];
        const next = segs[i + 1];
        piece = (prev && prev.art ? ' ' : s.lead) + tag + (next && next.art ? '' : s.trail);
      } else piece = s.lead + tag + s.trail;
    } else piece = s.raw;
    out += piece + (s.last ? '' : ',');
  });
  return out;
}

// 작가 블록만 한 줄로 (복사용).
export function artistLine(names, weights, space = true) {
  const sp = space ? ' ' : '';
  return names.map((n, i) => `${fmt(weights[i])}::artist:${n}${sp}::,`).join(' ');
}

const r1 = (x) => Math.round(x * 10) / 10;

// base: 기준 가중치, locked: 고정 여부. 평균이 avg가 되도록 0.1 단위로 맞춘다.
export function shuffleWeights(base, locked, { avg, min, max, jitter, mode }) {
  const n = base.length;
  const target = r1(avg * n);
  const free = base.map((_, i) => i).filter((i) => !locked[i]);
  if (!free.length) return base.slice();
  for (let tries = 0; tries < 400; tries++) {
    const w = base.map((b, i) => {
      if (locked[i]) return b;
      const v = mode === 'vary' ? b + (Math.random() * 2 - 1) * jitter : min + Math.random() * (max - min);
      return Math.min(max, Math.max(min, r1(v)));
    });
    let diff = r1(target - w.reduce((a, b) => a + b, 0));
    let guard = 0;
    while (Math.abs(diff) >= 0.05 && guard < 5000) {
      guard++;
      const i = free[Math.floor(Math.random() * free.length)];
      const step = diff > 0 ? 0.1 : -0.1;
      const nv = r1(w[i] + step);
      if (nv >= min - 1e-9 && nv <= max + 1e-9) {
        w[i] = nv;
        diff = r1(diff - step);
      }
    }
    if (Math.abs(diff) < 0.05) return w;
  }
  return null;
}

export function topArtists(names, weights, k = 4) {
  return names.map((n, i) => [weights[i], n]).sort((a, b) => b[0] - a[0]).slice(0, k);
}

// ---------------------------------------------------------------- 작가 순서
// 작가 자리(앞뒤 공백·줄바꿈)는 그대로 두고, 각 자리에 들어갈 작가(이름·가중치)만 order 순서로 바꾼다.
// order: 새 순서대로 늘어놓은 원래 작가 번호들.
export function reorder(segs, order) {
  const arts = segs.filter((s) => s.art);
  let k = 0;
  return segs.map((s) => {
    if (!s.art) return s;
    const src = arts[order[k]];
    k++;
    return { ...s, name: src.name, w: src.w };
  });
}

// 저장해 둔 이름 순서대로. 목록에 없는 작가는 원래 순서대로 맨 뒤에 둔다.
export function orderByNames(arts, names) {
  const pos = new Map(names.map((n, i) => [n, i]));
  const rank = (i) => (pos.has(arts[i].name) ? pos.get(arts[i].name) : 1e9 + i);
  return arts.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
}

export function shuffledOrder(n) {
  const o = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
}
