// Minimal ZIP reading and writing with the platform's own (de)compression streams: no library needed.
// Reading works on any Blob (a picked File too) by slicing, so a big export is never loaded whole.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const u8 = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

// The central directory of a zip held in a Blob: [{name, method, size, csize, offset}].
export async function zipEntries(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await u8(blob, blob.size - tailLen, blob.size);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 파일이 아닙니다.');
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  // ZIP64 (Python writes it for very large archives)
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tv.getUint32(loc, true) === 0x07064b50) {
      const z64Off = Number(tv.getBigUint64(loc + 8, true));
      const z = await u8(blob, z64Off, z64Off + 56);
      const zv = new DataView(z.buffer);
      count = Number(zv.getBigUint64(32, true));
      cdSize = Number(zv.getBigUint64(40, true));
      cdOffset = Number(zv.getBigUint64(48, true));
    }
  }
  const cd = await u8(blob, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer);
  const out = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.length; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    let csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = v.getUint16(e, true), len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(v.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(v.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(v.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    out.push({ name, method, size, csize, offset });
    p = eEnd + commentLen;
  }
  return out;
}

export async function readEntry(blob, entry) {
  const head = await u8(blob, entry.offset, entry.offset + 30);
  const hv = new DataView(head.buffer);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error('zip 항목을 읽지 못했습니다.');
  const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const data = await u8(blob, start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`지원하지 않는 압축 방식입니다 (${entry.method}).`);
}

// NovelAI answers with a zip holding image_0.png (or, rarely, the PNG itself).
export async function pngFromResponse(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return bytes;
  try {
    const blob = new Blob([bytes]);
    for (const entry of await zipEntries(blob)) {
      if (entry.name.toLowerCase().endsWith('.png')) return await readEntry(blob, entry);
    }
  } catch { /* not a zip */ }
  throw new Error('응답에서 PNG를 추출하지 못했습니다.');
}

// Streaming writer: add(name, bytes, {compress}) then finish(); ``sink(chunk)`` receives every piece in order.
export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.offset = 0;
    this.entries = [];
  }

  async write(bytes) {
    await this.sink(bytes);
    this.offset += bytes.length;
  }

  async add(name, bytes, { compress = false } = {}) {
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    let data = bytes, method = 0;
    if (compress) {
      const packed = await deflateRaw(bytes);
      if (packed.length < bytes.length) { data = packed; method = 8; }
    }
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const head = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 0x0800, true);  // UTF-8 names
    hv.setUint16(8, method, true);
    hv.setUint16(10, time, true);
    hv.setUint16(12, date, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, data.length, true);
    hv.setUint32(22, bytes.length, true);
    hv.setUint16(26, nameBytes.length, true);
    head.set(nameBytes, 30);
    const offset = this.offset;
    await this.write(head);
    await this.write(data);
    this.entries.push({ nameBytes, crc, csize: data.length, size: bytes.length, method, time, date, offset });
  }

  async finish() {
    const start = this.offset;
    let size = 0;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.csize, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.nameBytes, 46);
      await this.write(rec);
      size += rec.length;
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, start, true);
    await this.write(end);
  }
}

export const textBytes = (s) => enc.encode(s);
export const bytesText = (b) => dec.decode(b);
