// Fotos de comprovante: comprimidas no aparelho e guardadas no IndexedDB (o localStorage é pequeno demais).
const DB = 'rota-express';
const STORE = 'photos';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getPhoto = (id) => tx('readonly', (s) => s.get(id));
export const putPhoto = (id, blob) => tx('readwrite', (s) => s.put(blob, id));
export const clearPhotos = () => tx('readwrite', (s) => s.clear());
export const deletePhotos = (ids) => (ids.length ? tx('readwrite', (s) => ids.forEach((id) => s.delete(id))) : Promise.resolve());

/** Reduz a foto para no máximo `maxSide` px e converte em JPEG. */
export async function compressImage(file, { maxSide = 1280, quality = 0.7 } = {}) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao comprimir a foto.'))), 'image/jpeg', quality),
  );
}

/** Pede ao navegador para não apagar os dados do app automaticamente (quando suportado). */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

export const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Converte "data:image/...;base64,..." em Blob localmente (sem fetch — compatível com a CSP). */
export function dataUrlToBlob(url) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) throw new Error('Foto do backup em formato inválido.');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}
