import { describe, it, expect } from 'vitest';
import { summarize, periodDays } from '../src/lib/stats.js';

const now = new Date(2026, 9, 12, 18, 0); // 12/10/2026 18:00 (horário local)
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).toISOString();

const routes = [
  { // hoje, em andamento
    id: 'r1', createdAt: at(12, 8), plan: { distance: 20000 },
    stops: [
      { outcome: 'delivered', outcomeAt: at(12, 9) },
      { outcome: 'delivered', outcomeAt: at(12, 11, 30) },
      { outcome: 'failed', failReason: 'Cliente ausente', outcomeAt: at(12, 10) },
      { outcome: null },
    ],
  },
  { // há 3 dias
    id: 'r2', createdAt: at(9, 8), finishedAt: at(9, 17), plan: { distance: 35500 },
    stops: [
      { outcome: 'delivered', outcomeAt: at(9, 9) },
      { outcome: 'failed', failReason: 'Cliente ausente', outcomeAt: at(9, 9, 30) },
      { outcome: 'failed', failReason: 'Recusado', outcomeAt: at(9, 10) },
    ],
  },
  { // há 20 dias (fora da semana)
    id: 'r3', createdAt: new Date(2026, 8, 22, 8).toISOString(), finishedAt: new Date(2026, 8, 22, 17).toISOString(), plan: { distance: 10000 },
    stops: [{ outcome: 'delivered', outcomeAt: new Date(2026, 8, 22, 9).toISOString() }],
  },
];

describe('periodDays', () => {
  it('gera os dias do período terminando hoje', () => {
    expect(periodDays('today', now)).toEqual(['2026-10-12']);
    const week = periodDays('week', now);
    expect(week).toHaveLength(7);
    expect(week[0]).toBe('2026-10-06');
    expect(week[6]).toBe('2026-10-12');
  });
});

describe('summarize', () => {
  it('resumo de hoje', () => {
    const s = summarize(routes, 'today', now);
    expect(s).toMatchObject({ routes: 1, delivered: 2, failed: 1, km: 20, workMinutes: 150, activeDays: 1 });
    expect(s.successRate).toBeCloseTo(2 / 3);
    expect(s.reasons).toEqual([['Cliente ausente', 1]]);
  });

  it('resumo da semana soma rotas e agrupa motivos', () => {
    const s = summarize(routes, 'week', now);
    expect(s).toMatchObject({ routes: 2, delivered: 3, failed: 3, km: 55.5, activeDays: 2, perActiveDay: 1.5 });
    expect(s.workMinutes).toBe(150 + 60);
    expect(s.reasons).toEqual([['Cliente ausente', 2], ['Recusado', 1]]);
    const d9 = s.days.find((d) => d.date === '2026-10-09');
    expect(d9).toEqual({ date: '2026-10-09', delivered: 1, failed: 2, km: 35.5 });
  });

  it('30 dias inclui a rota antiga; período vazio não divide por zero', () => {
    expect(summarize(routes, 'month', now).delivered).toBe(4);
    const empty = summarize([], 'week', now);
    expect(empty).toMatchObject({ delivered: 0, successRate: null, perActiveDay: null, routes: 0 });
  });
});
