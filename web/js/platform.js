// The phone (Capacitor, Android) or a plain browser: one place that knows the difference.
// '@capacitor/core' is bundled into the app build; in a browser preview an import map points it at a small stand-in.
import { Capacitor, registerPlugin, CapacitorHttp } from '@capacitor/core';

export const native = Boolean(Capacitor?.isNativePlatform?.());

const Filesystem = registerPlugin('Filesystem');
const Share = registerPlugin('Share');
const AppPlugin = registerPlugin('App');
const Browser = registerPlugin('Browser');
const Clipboard = registerPlugin('Clipboard');
const StatusBar = registerPlugin('StatusBar');
const ScreenAwake = registerPlugin('ScreenAwake');

export { Filesystem, Capacitor };

// ---------------------------------------------------------------- bytes <-> base64
export function toBase64(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

export function fromBase64(text) {
  const bin = atob(String(text).replace(/^data:[^,]*,/, '').replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- HTTP
// Native: the request leaves from Android itself (no CORS, and the same headers novelai.net sends).
// Browser: fetch, without the headers a page may not set.
const FORBIDDEN = new Set(['origin', 'referer', 'user-agent', 'accept-language']);

export async function http({ url, method = 'GET', headers = {}, json, responseType = 'json', timeout = 120000 }) {
  if (native) {
    const res = await CapacitorHttp.request({
      url, method, headers, data: json, responseType: responseType === 'bytes' ? 'arraybuffer' : responseType,
      connectTimeout: 30000, readTimeout: timeout,
    });
    let data = res.data;
    if (responseType === 'bytes') {
      if (typeof data === 'string') data = fromBase64(data);
      else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      else if (data && typeof data === 'object') data = new TextEncoder().encode(JSON.stringify(data));
      else data = new Uint8Array(0);
    } else if (responseType === 'json' && typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* left as text */ }
    }
    return { status: res.status, data };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method, signal: controller.signal,
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !FORBIDDEN.has(k.toLowerCase()))),
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    let data;
    if (responseType === 'bytes') data = new Uint8Array(await res.arrayBuffer());
    else {
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export function bodyText(data) {
  if (data instanceof Uint8Array) return new TextDecoder().decode(data.subarray(0, 500));
  if (typeof data === 'string') return data.slice(0, 500);
  try { return JSON.stringify(data).slice(0, 500); } catch { return String(data); }
}

// ---------------------------------------------------------------- small device services
export async function copyToClipboard(text) {
  if (native) {
    try { await Clipboard.write({ string: text }); return; } catch { /* fall through */ }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('clipboard');
  }
}

export async function openExternal(url) {
  if (native) {
    try { await Browser.open({ url }); return; } catch { /* fall through */ }
  }
  window.open(url, '_blank', 'noopener');
}

export async function shareFile({ path, directory = 'DATA', title = '', text = '' }) {
  const { uri } = await Filesystem.getUri({ path, directory });
  await Share.share({ title, text, files: [uri], dialogTitle: title || '공유' });
}

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function onBackButton(handler) {
  if (native) AppPlugin.addListener('backButton', handler);
}

export function onPause(handler) {
  if (native) AppPlugin.addListener('pause', handler);
  document.addEventListener('visibilitychange', () => { if (document.hidden) handler(); });
  window.addEventListener('pagehide', handler);
}

export async function minimizeApp() {
  if (!native) return;
  try { await AppPlugin.minimizeApp(); } catch { try { await AppPlugin.exitApp(); } catch { /* nothing */ } }
}

export async function appVersion() {
  if (!native) return null;
  try { return (await AppPlugin.getInfo()).version; } catch { return null; }
}

export async function styleStatusBar() {
  if (!native) return;
  try {
    await StatusBar.setStyle({ style: 'DARK' });
    await StatusBar.setBackgroundColor({ color: '#141017' });
  } catch { /* optional plugin */ }
}

// Background generation (Android): a foreground service with a progress notification keeps the app running
// while another app is on screen. Quietly does nothing in a browser or if the phone refuses it.
export async function backgroundWork(on, title = '', text = '') {
  if (!native) return;
  try { await ScreenAwake.background({ on: Boolean(on), title, text }); } catch { /* the app then only runs while open */ }
}
export async function backgroundNotice(title, text) {
  if (!native) return;
  try { await ScreenAwake.notice({ title, text }); } catch { /* no notification permission */ }
}
// null in a browser; { unrestricted } on the phone (ask: open the system prompt to allow background running).
export async function batteryState(ask = false) {
  if (!native) return null;
  try { return await ScreenAwake.battery({ ask }); } catch { return null; }
}
let asked = false;
export async function askNotifications() {
  if (!native || asked) return;
  asked = true;
  try { await ScreenAwake.askNotifications(); } catch { /* older app shell */ }
}

// Keep the screen on while images are being made (generation would slow or stop with the screen off).
let lock = null;
export async function keepAwake(on) {
  keepAwake.wanted = on;
  if (native) {
    try { await ScreenAwake.set({ on: Boolean(on) }); return; } catch { /* fall back to the web API */ }
  }
  try {
    if (on && !lock && navigator.wakeLock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener?.('release', () => { lock = null; });
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch { lock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && keepAwake.wanted) keepAwake(true);
});
