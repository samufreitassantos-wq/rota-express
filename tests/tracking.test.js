import { describe, it, expect } from 'vitest';
import { newTracking, ingestFix, observedSpeedKmh, observedServiceMin, isArrived, isFresh, fmtDistance } from '../src/lib/tracking.js';

// 0,001° de latitude ≈ 111 m
const fix = (lat, tSec, acc = 5) => ({ lat, lng: 0, acc, t: tSec * 1000 });

describe('ingestFix', () => {
  it('soma distância e tempo em movimento', () => {
    let s = newTracking();
    for (let i = 0; i <= 10; i++) s = ingestFix(s, fix(i * 0.001, i * 10)); // 111 m a cada 10 s (~40 km/h)
    expect(s.meters).toBeCloseTo(1112, -1);
    expect(s.movingSeconds).toBe(100);
  });

  it('ignora tremor parado, leituras imprecisas e saltos impossíveis', () => {
    let s = ingestFix(newTracking(), fix(0, 0));
    s = ingestFix(s, fix(0.00005, 10)); // 5,5 m: tremor
    s = ingestFix(s, fix(0.002, 20, 500)); // precisão ruim
    s = ingestFix(s, fix(0.5, 30)); // 55 km em 30 s
    expect(s.meters).toBe(0);
    expect(s.last.t).toBe(0);
    expect(s.lastSeen.t).toBe(30000); // última leitura bruta (para exibir sinal fraco); posição usada é `last`
  });

  it('não conta como movimento o intervalo em que o app ficou em segundo plano', () => {
    let s = ingestFix(newTracking(), fix(0, 0));
    s = ingestFix(s, fix(0.02, 900)); // 2,2 km depois de 15 min sem leitura
    expect(s.meters).toBeCloseTo(2224, -1);
    expect(s.movingSeconds).toBe(0);
  });
});

describe('observados', () => {
  it('velocidade real só com dados suficientes', () => {
    expect(observedSpeedKmh({ movingMeters: 1000, movingSeconds: 600 })).toBeNull();
    expect(observedSpeedKmh({ movingMeters: 5000, movingSeconds: 720 })).toBeCloseTo(25);
  });
  it('tempo médio por parada com ao menos 3 amostras', () => {
    const st = (a, o) => ({ arrivedAt: `2026-10-12T10:${a}:00Z`, outcomeAt: `2026-10-12T10:${o}:00Z` });
    expect(observedServiceMin([st('00', '02'), st('10', '14')])).toBeNull();
    expect(observedServiceMin([st('00', '02'), st('10', '14'), st('20', '23'), { outcomeAt: 'x' }])).toBe(3);
  });
});

describe('chegada e formatação', () => {
  it('detecta chegada no raio, ampliado pela imprecisão', () => {
    const stop = { lat: 0, lng: 0 };
    expect(isArrived(fix(0.0004, 0), stop)).toBe(true); // 44 m
    expect(isArrived(fix(0.0007, 0), stop)).toBe(false); // 78 m
    expect(isArrived(fix(0.0007, 0, 90), stop)).toBe(true); // imprecisão de 90 m
  });
  it('leitura recente e distâncias', () => {
    expect(isFresh({ t: 1000 }, 60000)).toBe(true);
    expect(isFresh({ t: 1000 }, 200000)).toBe(false);
    expect(isFresh(null)).toBe(false);
    expect(fmtDistance(85.4)).toBe('85 m');
    expect(fmtDistance(1234)).toBe('1,2 km');
  });
});
