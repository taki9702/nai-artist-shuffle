// 폰 안에 저장: 설정·즐겨찾기(kv), 뽑기 기록(runs), 그림 PNG(images). 모두 IndexedDB.
const DB_NAME = 'nai-artist-shuffle';

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['kv', 'runs', 'images']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장하지 못했습니다.'));
  });
}

export const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key));

export const runPut = (run) => tx('runs', 'readwrite', (s) => s.put(run, run.id));
export const runDelete = (id) => tx('runs', 'readwrite', (s) => s.delete(id));
export async function runList() {
  const all = await tx('runs', 'readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => b.created - a.created);
}

export const imagePut = (id, blob) => tx('images', 'readwrite', (s) => s.put(blob, id));
export const imageGet = (id) => tx('images', 'readonly', (s) => s.get(id));
export const imageDelete = (id) => tx('images', 'readwrite', (s) => s.delete(id));

export async function usage() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? e.usage : null;
  } catch { return null; }
}
