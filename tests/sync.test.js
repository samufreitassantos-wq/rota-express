import { describe, it, expect } from 'vitest';
import { syncOnce, newSyncMeta, pendingCount, routeToRow } from '../src/lib/sync.js';

/** Nuvem falsa em memória com o mesmo contrato do adaptador real. */
function fakeCloud() {
  const rows = new Map();
  const photos = new Map();
  return {
    rows, photos,
    async upsertRoutes(list) { for (const r of list) rows.set(r.id, structuredClone(r)); },
    async fetchMyRoutes(uid) { return [...rows.values()].filter((r) => r.user_id === uid).map((r) => structuredClone(r)); },
    async deleteRoute(id) { rows.delete(id); },
    async uploadPhoto(path, blob) { photos.set(path, blob); },
    async removePhotos(paths) { paths.forEach((p) => photos.delete(p)); },
  };
}
const route = (id, extra = {}) => ({ id, name: id, createdAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-12T08:00:00Z', stops: [{ id: `${id}-s1`, address: 'Rua A' }], ...extra });
const empty = { id: 'vazia', stops: [] };
let tick = 0;
const now = () => new Date(Date.parse('2026-10-12T12:00:00Z') + ++tick * 1000).toISOString();

describe('syncOnce', () => {
  it('envia rotas alteradas e não reenvia as já sincronizadas', async () => {
    const cloud = fakeCloud();
    const state = { current: route('atual'), history: [route('h1', { finishedAt: '2026-10-11T17:00:00Z' })] };
    let r = await syncOnce({ adapter: cloud, userId: 'u1', state, meta: newSyncMeta(), getPhoto: async () => null, now });
    expect(r.pushed).toBe(2);
    expect(cloud.rows.get('atual')).toMatchObject({ user_id: 'u1', finished_at: null });
    r = await syncOnce({ adapter: cloud, userId: 'u1', state: r.state, meta: r.meta, getPhoto: async () => null, now });
    expect(r.pushed).toBe(0);
    expect(pendingCount(r.state, r.meta)).toBe(0);
  });

  it('data no formato do Postgres (+00:00) não faz reenviar tudo', async () => {
    const cloud = fakeCloud();
    const pgFormat = (iso) => iso.replace('.000Z', '+00:00');
    cloud.fetchMyRoutes = async (uid) => [...cloud.rows.values()].filter((r) => r.user_id === uid).map((r) => ({ ...structuredClone(r), updated_at: pgFormat(r.updated_at) }));
    const state = { current: route('r', { updatedAt: '2026-10-12T08:00:00.000Z' }), history: [] };
    let r = await syncOnce({ adapter: cloud, userId: 'u1', state, meta: newSyncMeta(), getPhoto: async () => null, now });
    expect(r.pushed).toBe(1);
    r = await syncOnce({ adapter: cloud, userId: 'u1', state: r.state, meta: r.meta, getPhoto: async () => null, now });
    expect(r.pushed).toBe(0);
    expect(r.pulled).toBe(0);
    expect(pendingCount(r.state, r.meta)).toBe(0);
  });

  it('rota atual vazia não sobe', async () => {
    const cloud = fakeCloud();
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: empty, history: [] }, meta: newSyncMeta(), getPhoto: async () => null, now });
    expect(r.pushed).toBe(0);
    expect(cloud.rows.size).toBe(0);
  });

  it('aparelho novo recebe histórico e continua a rota em andamento', async () => {
    const cloud = fakeCloud();
    await cloud.upsertRoutes([
      routeToRow(route('andamento'), 'u1'),
      routeToRow(route('velha', { finishedAt: '2026-10-10T17:00:00Z' }), 'u1'),
      routeToRow(route('de-outra-pessoa', { finishedAt: '2026-10-10T17:00:00Z' }), 'u2'),
    ]);
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: empty, history: [] }, meta: newSyncMeta(), getPhoto: async () => null, now });
    expect(r.adoptedCurrent).toBe(true);
    expect(r.state.current.id).toBe('andamento');
    expect(r.state.history.map((h) => h.id)).toEqual(['velha']);
  });

  it('edição offline mais antiga não sobrescreve a versão mais nova de outro aparelho', async () => {
    const cloud = fakeCloud();
    await cloud.upsertRoutes([routeToRow({ ...route('r'), name: 'editada em outro aparelho', updatedAt: '2026-10-12T10:00:00Z' }, 'u1')]);
    const local = route('r', { name: 'edição offline', updatedAt: '2026-10-12T09:00:00Z' });
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: local, history: [] }, meta: { synced: { r: '2026-10-12T08:00:00Z' }, deleted: [] }, getPhoto: async () => null, now });
    expect(r.pushed).toBe(0);
    expect(cloud.rows.get('r').data.name).toBe('editada em outro aparelho');
    expect(r.state.current.name).toBe('editada em outro aparelho');
  });

  it('edição local mais nova sobe e substitui a da nuvem', async () => {
    const cloud = fakeCloud();
    await cloud.upsertRoutes([routeToRow({ ...route('r'), name: 'antiga', updatedAt: '2026-10-12T08:00:00Z' }, 'u1')]);
    const local = route('r', { name: 'nova', updatedAt: '2026-10-12T11:00:00Z' });
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: local, history: [] }, meta: { synced: { r: '2026-10-12T08:00:00Z' }, deleted: [] }, getPhoto: async () => null, now });
    expect(r.pushed).toBe(1);
    expect(cloud.rows.get('r').data.name).toBe('nova');
  });

  it('rota excluída em outro aparelho some deste também', async () => {
    const cloud = fakeCloud();
    const h = route('h', { finishedAt: '2026-10-11T17:00:00Z' });
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: empty, history: [h] }, meta: { synced: { h: h.updatedAt }, deleted: [] }, getPhoto: async () => null, now });
    expect(r.removed).toBe(1);
    expect(r.state.history).toEqual([]);
    expect(cloud.rows.size).toBe(0);
  });

  it('não sobrescreve alteração mais nova da nuvem com uma local antiga já sincronizada', async () => {
    const cloud = fakeCloud();
    await cloud.upsertRoutes([routeToRow({ ...route('r'), name: 'nova', updatedAt: '2026-10-12T10:00:00Z' }, 'u1')]);
    const local = route('r', { updatedAt: '2026-10-12T08:00:00Z' });
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: local, history: [] }, meta: { synced: { r: '2026-10-12T08:00:00Z' }, deleted: [] }, getPhoto: async () => null, now });
    expect(r.pushed).toBe(0);
    expect(r.state.current.name).toBe('nova');
  });

  it('envia fotos pendentes uma vez e marca a rota para subir', async () => {
    const cloud = fakeCloud();
    const cur = route('f');
    cur.stops[0].hasPhoto = true;
    const meta = { synced: { f: cur.updatedAt }, deleted: [] };
    expect(pendingCount({ current: cur, history: [] }, meta)).toBe(1);
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: cur, history: [] }, meta, getPhoto: async () => 'BLOB', now });
    expect(r.photosUp).toBe(1);
    expect(cloud.photos.get('u1/f-s1.jpg')).toBe('BLOB');
    expect(cloud.rows.get('f').data.stops[0].photoSynced).toBe(true);
  });

  it('exclusões pendentes apagam rota e fotos na nuvem e não voltam', async () => {
    const cloud = fakeCloud();
    await cloud.upsertRoutes([routeToRow(route('x', { finishedAt: '2026-10-10T17:00:00Z' }), 'u1')]);
    await cloud.uploadPhoto('u1/x-s1.jpg', 'B');
    const r = await syncOnce({ adapter: cloud, userId: 'u1', state: { current: empty, history: [] }, meta: { synced: {}, deleted: [{ id: 'x', photoIds: ['x-s1'] }] }, getPhoto: async () => null, now });
    expect(cloud.rows.has('x')).toBe(false);
    expect(cloud.photos.size).toBe(0);
    expect(r.state.history).toEqual([]);
    expect(r.meta.deleted).toEqual([]);
  });

  it('falha de rede interrompe sem perder o que está pendente', async () => {
    const cloud = fakeCloud();
    cloud.upsertRoutes = async () => { throw new Error('Failed to fetch'); };
    const state = { current: route('p'), history: [] };
    await expect(syncOnce({ adapter: cloud, userId: 'u1', state, meta: newSyncMeta(), getPhoto: async () => null, now })).rejects.toThrow('Failed to fetch');
    expect(pendingCount(state, newSyncMeta())).toBe(1);
  });
});
