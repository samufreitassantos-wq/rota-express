import { describe, it, expect } from 'vitest';
import { sanitizeRoute, sanitizeStop, safeId } from '../src/lib/sanitize.js';

const XSS = '"><img src=x onerror=alert(1)>';

describe('sanitize', () => {
  it('neutraliza o ataque real (id com atributos HTML)', () => {
    const r = sanitizeRoute({ id: 'x" onmouseover="window.__xss=1" style="', stops: [], plan: { order: ['a" onclick="x'] } });
    expect(r.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(r.plan.order[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('enums e horários fora do formato são descartados', () => {
    const s = sanitizeStop({ id: 's1', address: 'Rua A', status: XSS, outcome: XSS, windowStart: XSS, windowEnd: '25:00' });
    expect(s.status).toBe('pending');
    expect(s.outcome).toBeNull();
    expect(s.windowStart).toBeUndefined();
    expect(s.windowEnd).toBeUndefined();
    expect(sanitizeStop({ id: 's', windowStart: '08:30' }).windowStart).toBe('08:30');
  });

  it('números, coordenadas e datas viram tipos válidos', () => {
    const s = sanitizeStop({ id: 's', lat: '-23.5', lng: 999, outcomeAt: XSS, outcomeDistM: XSS, hasPhoto: 'sim' });
    expect(s.lat).toBe(-23.5);
    expect(s.lng).toBeUndefined();
    expect(s.outcomeAt).toBeUndefined();
    expect(s.outcomeDistM).toBeUndefined();
    expect(s.hasPhoto).toBeUndefined();
  });

  it('texto livre é mantido (é escapado na tela) mas com tamanho limitado', () => {
    const s = sanitizeStop({ id: 's', address: XSS, note: 'x'.repeat(5000) });
    expect(s.address).toBe(XSS);
    expect(s.note).toHaveLength(1000);
  });

  it('preserva uma rota legítima', () => {
    const route = {
      id: 'abc123', name: 'Rota 12/10', createdAt: '2026-10-12T08:00:00.000Z', updatedAt: '2026-10-12T09:00:00.000Z', finishedAt: null,
      start: { input: 'Rua 0', lat: -23.5, lng: -46.6 },
      stops: [{ id: 's1', address: 'Rua A, 1', status: 'ok', lat: -23.51, lng: -46.61, outcome: 'delivered', outcomeAt: '2026-10-12T08:30:00.000Z', note: 'Portaria', hasPhoto: true, photoSynced: true, windowStart: '08:00', windowEnd: '12:00', arrivedAt: '2026-10-12T08:28:00.000Z', outcomeDistM: 12 }],
      plan: { order: ['s1'], geometry: [[-23.5, -46.6], [-23.51, -46.61]], distance: 1500, duration: null, method: 'ors', roadGeometry: true, warnings: [], start: { lat: -23.5, lng: -46.6 } },
      tracking: { active: true, meters: 1200, movingMeters: 1000, movingSeconds: 120, last: { lat: -23.5, lng: -46.6, acc: 8, t: 1 } },
    };
    expect(sanitizeRoute(route)).toEqual(route);
  });

  it('converte o formato antigo sem perder entregas', () => {
    expect(sanitizeStop({ id: 's', delivered: true, deliveredAt: '2026-01-01T10:00:00Z' })).toMatchObject({ outcome: 'delivered', outcomeAt: '2026-01-01T10:00:00Z' });
    expect(sanitizeStop({ id: 's', delivered: false }).outcome).toBeNull();
    expect(sanitizeStop({ id: 's', outcome: 'failed', delivered: true }).outcome).toBe('failed');
  });

  it('ids', () => {
    expect(safeId('ok_ID-1')).toBe('ok_ID-1');
    expect(safeId('../x')).toBe('___x');
    expect(safeId('')).toMatch(/^id_/);
    expect(sanitizeRoute({ id: 'x' })).toBeNull();
  });
});
