import { describe, it, expect, vi } from 'vitest';
import { orsGeocode, orsOptimize, orsDirections } from '../src/lib/ors.js';
import { planRoute } from '../src/lib/planner.js';
import { buildQuery } from '../src/lib/geocode.js';

const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

// Respostas simuladas no formato documentado da API; não há chamada real à rede aqui.
describe('cliente ORS (fetch simulado)', () => {
  it('geocode envia a chave no cabeçalho e lê [lng, lat]', async () => {
    const fetchImpl = vi.fn(() => ok({ features: [{ geometry: { coordinates: [-46.6, -23.5] }, properties: { label: 'X', confidence: 0.9 } }] }));
    const r = await orsGeocode('Rua A, 1', { key: 'k', fetchImpl });
    expect(r).toEqual({ lat: -23.5, lng: -46.6, label: 'X', confidence: 0.9 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/geocode/search');
    expect(url).not.toContain('k&');
    expect(init.headers.Authorization).toBe('k');
  });

  it('optimize converte steps em índices e anexa não atribuídos', async () => {
    const fetchImpl = vi.fn(() => ok({ routes: [{ steps: [{ type: 'start' }, { type: 'job', id: 3 }, { type: 'job', id: 1 }, { type: 'end' }] }] }));
    const stops = [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
    expect(await orsOptimize({ lat: 0, lng: 0 }, stops, { key: 'k', fetchImpl })).toEqual({ order: [2, 0, 1], unassigned: 1 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.jobs[0].time_windows).toBeUndefined();
    expect(body.vehicles[0].time_window).toBeUndefined();
  });

  it('optimize envia janelas, tempo de serviço e hora de saída em segundos', async () => {
    const fetchImpl = vi.fn(() => ok({ routes: [{ steps: [{ type: 'job', id: 1 }, { type: 'job', id: 2 }] }] }));
    const stops = [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }];
    await orsOptimize({ lat: 0, lng: 0 }, stops, { key: 'k', fetchImpl, windows: [{ start: 840, end: 960 }, null], startMin: 480, serviceMin: 3 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.jobs[0]).toMatchObject({ service: 180, time_windows: [[50400, 57600]] });
    expect(body.jobs[1].time_windows).toBeUndefined();
    expect(body.vehicles[0].time_window).toEqual([28800, 172800]);
  });

  it('directions divide em blocos de 50 pontos sem duplicar emendas', async () => {
    const fetchImpl = vi.fn((url, init) => {
      const coords = JSON.parse(init.body).coordinates;
      return ok({ features: [{ geometry: { coordinates: coords }, properties: { summary: { distance: 10, duration: 5 } } }] });
    });
    const pts = Array.from({ length: 61 }, (_, i) => ({ lat: i, lng: i }));
    const d = await orsDirections(pts, { key: 'k', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(d.coords).toHaveLength(61);
    expect(d.distance).toBe(20);
  });

  it('sem chave, planRoute usa otimização local e não chama a rede', async () => {
    const fetchImpl = vi.fn();
    const r = await planRoute({ lat: 0, lng: 0 }, [{ lat: 0, lng: 2 }, { lat: 0, lng: 1 }], { fetchImpl });
    expect(r.order).toEqual([1, 0]);
    expect(r.method).toBe('local');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('planRoute local respeita janela e avisa atraso inevitável', async () => {
    const stops = [{ lat: 0, lng: 0.01 }, { lat: 0, lng: 0.05 }];
    const timing = { speedKmh: 30, serviceMin: 3, detour: 1 };
    const r = await planRoute({ lat: 0, lng: 0 }, stops, { windows: [null, { start: 0, end: 492 }], startMin: 480, timing });
    expect(r.order).toEqual([1, 0]);
    expect(r.warnings).toEqual([]);
    const late = await planRoute({ lat: 0, lng: 0 }, stops, { windows: [null, { start: 0, end: 482 }], startMin: 480, timing });
    expect(late.warnings[0]).toContain('1 parada(s) chegariam depois');
  });

  it('se a ORS falhar, planRoute cai para o modo local com aviso', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Quota' }) }));
    const r = await planRoute({ lat: 0, lng: 0 }, [{ lat: 0, lng: 2 }, { lat: 0, lng: 1 }], { key: 'k', fetchImpl });
    expect(r.method).toBe('local');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('403');
  });
});

describe('buildQuery', () => {
  it('acrescenta a cidade padrão somente quando falta localidade', () => {
    expect(buildQuery('Rua A, 1', 'Campinas - SP')).toBe('Rua A, 1, Campinas - SP');
    expect(buildQuery('Rua A, 1, 13010-000', 'Campinas - SP')).toBe('Rua A, 1, 13010-000');
    expect(buildQuery('Rua A, 1, Santos - SP', 'Campinas - SP')).toBe('Rua A, 1, Santos - SP');
  });
});
