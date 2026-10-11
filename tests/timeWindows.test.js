import { describe, it, expect } from 'vitest';
import { parseHHMM, fmtHHMM, stopWindow, hasWindows, travelMin, simulate, optimizeWithWindows } from '../src/lib/timeWindows.js';

describe('horários', () => {
  it('converte HH:MM', () => {
    expect(parseHHMM('14:30')).toBe(870);
    expect(parseHHMM('7:05')).toBe(425);
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('')).toBeNull();
    expect(fmtHHMM(870)).toBe('14:30');
    expect(fmtHHMM(1445)).toBe('00:05');
  });
  it('lê a janela da parada (início ou fim podem faltar)', () => {
    expect(stopWindow({ windowStart: '14:00', windowEnd: '16:00' })).toEqual({ start: 840, end: 960 });
    expect(stopWindow({ windowEnd: '10:00' })).toEqual({ start: 0, end: 600 });
    expect(stopWindow({})).toBeNull();
    expect(hasWindows([{}, { windowStart: '09:00' }])).toBe(true);
    expect(hasWindows([{}])).toBe(false);
  });
});

// ~1,11 km por 0,01° de latitude
const p = (lat) => ({ lat, lng: 0 });

describe('simulate', () => {
  it('espera quando chega cedo e conta atraso quando chega tarde', () => {
    const opts = { speedKmh: 60, detour: 1, serviceMin: 5 };
    const t1 = travelMin(p(0), p(0.1), opts); // ~11,1 min
    const r = simulate([p(0), p(0.1), p(0.2)], [null, { start: 600, end: 700 }, { start: 0, end: 600 }], 480, opts);
    expect(r.stops[0].wait).toBeCloseTo(600 - 480 - t1, 5);
    expect(r.stops[0].arrival).toBe(600);
    expect(r.stops[1].late).toBeCloseTo(600 + 5 + t1 - 600, 5);
    expect(r.lateCount).toBe(1);
  });
});

describe('optimizeWithWindows', () => {
  const opts = { speedKmh: 30, detour: 1, serviceMin: 3 };
  it('sem janelas, igual à otimização por distância', () => {
    const pts = [p(0), p(0.03), p(0.01), p(0.02)];
    expect(optimizeWithWindows(pts, [], 480, opts)).toEqual([2, 3, 1]);
  });

  it('antecipa a parada que fecha cedo, sem atraso', () => {
    // Parada 3 (~5,6 km, ~11 min) só recebe até 08:15: passando antes pelas outras chegaria ~08:17.
    const pts = [p(0), p(0.01), p(0.02), p(0.05)];
    const windows = [null, null, null, { start: 0, end: 495 }];
    const order = optimizeWithWindows(pts, windows, 480, opts);
    expect(order).not.toEqual([1, 2, 3]); // a ordem só por distância atrasaria a parada 3
    expect(order.indexOf(3)).toBeLessThan(2);
    const sim = simulate([pts[0], ...order.map((i) => pts[i])], [null, ...order.map((i) => windows[i])], 480, opts);
    expect(sim.lateCount).toBe(0);
  });

  it('deixa para depois a parada que só abre mais tarde', () => {
    const pts = [p(0), p(0.01), p(0.02), p(0.03)];
    const windows = [null, { start: 600, end: 720 }, null, null]; // a mais próxima só abre às 10:00
    const order = optimizeWithWindows(pts, windows, 480, opts);
    expect(order[order.length - 1]).toBe(1);
  });

  it('quando a espera iguala o término, prefere o menor trajeto', () => {
    // 5 paradas em linha; a 5ª (mais longe) fecha cedo e a 1ª (mais perto) só abre às 10:00.
    const pts = [p(0), p(0.009), p(0.018), p(0.027), p(0.036), p(0.045)];
    const windows = [null, { start: 600, end: 1440 }, null, null, null, { start: 0, end: 500 }];
    const order = optimizeWithWindows(pts, windows, 480, opts);
    const sim = simulate([pts[0], ...order.map((i) => pts[i])], [null, ...order.map((i) => windows[i])], 480, opts);
    expect(sim.lateCount).toBe(0);
    expect(order.at(-1)).toBe(1);
    // Trajeto mínimo: ir até o fim da linha (0,045°) e voltar até a 1ª parada (0,036°).
    expect(sim.travel).toBeCloseTo(travelMin(p(0), p(0.081), opts), 5);
  });

  it('com 40 paradas e várias janelas, retorna permutação válida sem atrasos evitáveis', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pts = Array.from({ length: 41 }, () => ({ lat: -23.5 + rnd() * 0.1, lng: -46.6 + rnd() * 0.1 }));
    const windows = pts.map((_, i) => (i > 0 && i % 8 === 0 ? { start: 480, end: 540 } : null)); // 5 paradas até 09:00
    const order = optimizeWithWindows(pts, windows, 480, opts);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const sim = simulate([pts[0], ...order.map((i) => pts[i])], [null, ...order.map((i) => windows[i])], 480, opts);
    expect(sim.lateCount).toBe(0);
  });
});
