/* 模型快取：把 whisper.cpp 模型檔存進 IndexedDB，之後免重新下載。
 *
 * 桌面端由 bootstrap.py 下載到 models/；網頁版沒有檔案系統，改用 IndexedDB
 * （容量通常足夠放 848 MB ~ 1 GB 的單一模型，且不受 HTTP 快取淘汰影響）。
 */

const DB_NAME = "taigi-asr-web";
const DB_VERSION = 1;
const STORE = "models";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("無法開啟 IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB 被其他分頁鎖住，請關閉其他分頁後重試"));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try {
        result = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB 交易失敗"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB 交易取消"));
    });
  } finally {
    db.close();
  }
}

export async function getCachedModel(key) {
  try {
    const record = await withStore("readonly", (store) => store.get(key));
    if (record && record.blob) {
      return { blob: record.blob, size: record.size ?? record.blob.size, savedAt: record.savedAt };
    }
    return null;
  } catch (err) {
    console.warn("讀取模型快取失敗", err);
    return null;
  }
}

export async function putCachedModel(key, blob) {
  try {
    await withStore("readwrite", (store) =>
      store.put({ blob, size: blob.size, savedAt: Date.now() }, key),
    );
    return true;
  } catch (err) {
    console.warn("寫入模型快取失敗（可能是空間不足）", err);
    return false;
  }
}

export async function deleteCachedModel(key) {
  try {
    await withStore("readwrite", (store) => store.delete(key));
  } catch (err) {
    console.warn("刪除模型快取失敗", err);
  }
}

export async function cachedModelKeys() {
  try {
    const keys = await withStore("readonly", (store) => store.getAllKeys());
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

/** 查詢可用儲存空間（部分瀏覽器不支援）。 */
export async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** 要求瀏覽器不要自動清掉我們的資料。 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * 取得模型 Blob：先查快取，否則下載（支援 progress 與取消）。
 * onProgress({ received, total, fromCache })
 */
export async function ensureModelBlob(key, url, totalBytes, { onProgress, signal } = {}) {
  const cached = await getCachedModel(key);
  if (cached) {
    onProgress?.({ received: cached.size, total: cached.size, fromCache: true });
    return { blob: cached.blob, fromCache: true };
  }

  onProgress?.({ received: 0, total: totalBytes, fromCache: false });
  const response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`模型下載失敗（HTTP ${response.status}）`);
  }

  const total = Number(response.headers.get("content-length")) || totalBytes || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    onProgress?.({ received: blob.size, total: blob.size, fromCache: false });
    await putCachedModel(key, blob);
    return { blob, fromCache: false };
  }

  const chunks = [];
  let received = 0;
  let lastEmit = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = Date.now();
    if (now - lastEmit > 200) {
      lastEmit = now;
      onProgress?.({ received, total, fromCache: false });
    }
  }
  onProgress?.({ received, total: total || received, fromCache: false });

  const blob = new Blob(chunks, { type: "application/octet-stream" });
  await requestPersistentStorage();
  const stored = await putCachedModel(key, blob);
  if (!stored) {
    console.warn("模型未能寫入快取，下次開啟需重新下載");
  }
  return { blob, fromCache: false };
}
