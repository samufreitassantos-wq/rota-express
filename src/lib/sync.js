// Sincronização entre o aparelho e a nuvem. O aparelho continua sendo a fonte de trabalho
// (funciona sem internet); a cada sincronização:
//  1) exclusões pendentes são aplicadas na nuvem;
//  2) fotos ainda não enviadas sobem;
//  3) cada rota é comparada com a da nuvem: sobe a do aparelho se for mais nova, desce a da
//     nuvem se for mais nova (ex.: outro aparelho da mesma pessoa).
// Conflito: vale a versão com `updatedAt` mais recente (a rota inteira).
// Rota que já tinha sido sincronizada e sumiu da nuvem foi excluída em outro aparelho.
import { photoPath } from './cloudPaths.js';

export const newSyncMeta = () => ({ synced: {}, deleted: [] });

const time = (iso) => Date.parse(iso ?? '') || 0;
// O Supabase devolve datas como "…+00:00" e o app grava "…Z": compara o instante, não o texto.
const isSynced = (meta, r) => r.id in meta.synced && time(meta.synced[r.id]) === time(r.updatedAt);

export function routeToRow(route, userId) {
  return {
    id: route.id,
    user_id: userId,
    name: route.name ?? null,
    created_at: route.createdAt ?? null,
    finished_at: route.finishedAt ?? null,
    updated_at: route.updatedAt ?? route.createdAt ?? new Date().toISOString(),
    data: route,
  };
}

/** Quantas alterações locais ainda não foram enviadas. */
export function pendingCount(state, meta) {
  const routes = [state.current, ...state.history].filter((r) => r?.stops?.length);
  const dirty = routes.filter((r) => !isSynced(meta, r)).length;
  const photos = routes.reduce((n, r) => n + r.stops.filter((s) => s.hasPhoto && !s.photoSynced).length, 0);
  return dirty + photos + meta.deleted.length;
}

/**
 * Executa uma sincronização. `state` = { current, history } (pode ser alterado);
 * retorna { state, meta, pushed, pulled, photosUp, adoptedCurrent, removed }.
 */
export async function syncOnce({ adapter, userId, state, meta, getPhoto, now = () => new Date().toISOString(), historyMax = Infinity }) {
  meta = { synced: { ...meta.synced }, deleted: [...meta.deleted] };
  let { current, history } = state;
  history = [...history];

  // 1) Exclusões
  for (const del of [...meta.deleted]) {
    await adapter.deleteRoute(del.id);
    await adapter.removePhotos(del.photoIds.map((sid) => photoPath(userId, sid)));
    meta.deleted = meta.deleted.filter((d) => d.id !== del.id);
    delete meta.synced[del.id];
  }

  // 2) Fotos pendentes (marca a rota como alterada para registrar photoSynced)
  let photosUp = 0;
  for (const r of [current, ...history]) {
    if (!r?.stops) continue;
    for (const s of r.stops) {
      if (!s.hasPhoto || s.photoSynced) continue;
      const blob = await getPhoto(s.id);
      if (!blob) continue;
      await adapter.uploadPhoto(photoPath(userId, s.id), blob);
      s.photoSynced = true;
      r.updatedAt = now();
      photosUp++;
    }
  }

  // 3) Compara com a nuvem: envia o que é mais novo aqui, recebe o que é mais novo lá.
  const remote = await adapter.fetchMyRoutes(userId);
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const toPush = [];
  let pulled = 0;
  let adoptedCurrent = false;
  const removed = new Set();

  for (const r of [current, ...history]) {
    if (!r?.stops?.length) continue;
    r.updatedAt ??= r.createdAt ?? now();
    const row = remoteById.get(r.id);
    const dirty = !isSynced(meta, r);
    if (!row) {
      if (dirty || !(r.id in meta.synced)) toPush.push(r);
      else removed.add(r.id); // já estava na nuvem e sumiu: excluída em outro aparelho
    } else if (time(r.updatedAt) > time(row.updated_at)) {
      toPush.push(r);
    }
  }
  await adapter.upsertRoutes(toPush.map((r) => routeToRow(r, userId)));
  for (const r of toPush) meta.synced[r.id] = r.updatedAt;
  const pushedIds = new Set(toPush.map((r) => r.id));

  if (removed.size) {
    history = history.filter((h) => !removed.has(h.id));
    for (const id of removed) delete meta.synced[id];
  }

  for (const row of remote) {
    if (pushedIds.has(row.id)) continue;
    const data = { ...row.data, updatedAt: row.updated_at };
    const isCurrent = current?.id === row.id;
    const local = isCurrent ? current : history.find((h) => h.id === row.id);
    if (local) {
      if (time(row.updated_at) > time(local.updatedAt)) {
        if (isCurrent) current = data;
        else history = history.map((h) => (h.id === row.id ? data : h));
        pulled++;
      }
    } else if (row.finished_at) {
      history.push(data);
      pulled++;
    } else if (!current?.stops?.length) {
      current = data; // aparelho novo/vazio: continua a rota em andamento de outro aparelho
      adoptedCurrent = true;
      pulled++;
    }
    meta.synced[row.id] = row.updated_at;
  }

  history.sort((a, b) => time(b.finishedAt ?? b.createdAt) - time(a.finishedAt ?? a.createdAt));
  history = history.slice(0, historyMax);
  return { state: { current, history }, meta, pushed: toPush.length, pulled, photosUp, adoptedCurrent, removed: removed.size };
}
