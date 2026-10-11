// Janelas de horário por parada e estimativa de horários de chegada (ETA).
// Tempos em minutos desde a meia-noite. A estimativa local usa distância em linha reta
// com fator de desvio e velocidade média — é aproximada, serve para ordenar e alertar.
import { haversine, optimizeOrder } from './geo.js';

export const DEFAULTS = { speedKmh: 25, serviceMin: 3, detour: 1.35 };
const LATE_PENALTY = 20; // cada minuto de atraso "custa" 20 min de trajeto na otimização

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

export function fmtHHMM(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Janela {start, end} em minutos a partir de uma parada (campos windowStart/windowEnd "HH:MM"). */
export function stopWindow(s) {
  const start = parseHHMM(s.windowStart);
  const end = parseHHMM(s.windowEnd);
  if (start == null && end == null) return null;
  return { start: start ?? 0, end: end ?? 24 * 60 };
}

export const hasWindows = (stops) => stops.some((s) => stopWindow(s));

export function travelMin(a, b, { speedKmh = DEFAULTS.speedKmh, detour = DEFAULTS.detour } = {}) {
  return (haversine(a, b) * detour) / 1000 / speedKmh * 60;
}

/**
 * Simula a rota: points[0] = partida, points[1..] = paradas na ordem; windows[i] para points[i] (i ≥ 1).
 * Chegando antes da janela, espera; depois do fim, conta atraso.
 * @returns {{ stops: {arrival, wait, late}[], end: number, travel: number, lateTotal: number, lateCount: number }}
 */
export function simulate(points, windows, startMin, opts = {}) {
  const service = opts.serviceMin ?? DEFAULTS.serviceMin;
  let t = startMin;
  let travel = 0;
  let lateTotal = 0;
  let lateCount = 0;
  const stops = [];
  for (let i = 1; i < points.length; i++) {
    const leg = travelMin(points[i - 1], points[i], opts);
    travel += leg;
    const arrival = t + leg;
    const w = windows[i];
    const begin = w ? Math.max(arrival, w.start) : arrival;
    const late = w ? Math.max(0, begin - w.end) : 0;
    if (late > 0) {
      lateTotal += late;
      lateCount++;
    }
    stops.push({ arrival: begin, wait: begin - arrival, late });
    t = begin + service;
  }
  return { stops, end: t, travel, lateTotal, lateCount };
}

/**
 * Ordem das paradas respeitando janelas (heurística local).
 * points[0] = partida; windows[i] para points[i]. Retorna índices 1..n.
 * Sem nenhuma janela, usa a otimização por distância de sempre.
 */
export function optimizeWithWindows(points, windows, startMin, opts = {}) {
  const n = points.length - 1;
  if (n <= 0) return [];
  const matrixOrder = () => {
    const m = points.map((p) => points.map((q) => haversine(p, q)));
    return optimizeOrder(m);
  };
  if (!windows.some(Boolean)) return matrixOrder();

  const cost = (order) => {
    const r = simulate([points[0], ...order.map((i) => points[i])], [null, ...order.map((i) => windows[i])], startMin, opts);
    // Tempo total + atraso (pesado) + trajeto: o trajeto desempata quando a espera por uma
    // janela deixa várias ordens com o mesmo horário de término.
    return r.end - startMin + LATE_PENALTY * r.lateTotal + r.travel;
  };

  // Começa pela melhor de duas: rota por distância, ou por fim da janela (paradas sem janela no fim).
  const byDistance = matrixOrder();
  const byDeadline = Array.from({ length: n }, (_, k) => k + 1)
    .sort((a, b) => (windows[a]?.end ?? Infinity) - (windows[b]?.end ?? Infinity));
  let order = cost(byDistance) <= cost(byDeadline) ? byDistance : byDeadline;
  let best = cost(order);

  // Busca local: mover uma parada para outra posição (relocate) e inverter trechos (2-opt).
  for (let pass = 0, improved = true; improved && pass < (opts.maxPasses ?? 30); pass++) {
    improved = false;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = order.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x);
        const c = cost(cand);
        if (c + 1e-6 < best) {
          order = cand;
          best = c;
          improved = true;
        }
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        const c = cost(cand);
        if (c + 1e-6 < best) {
          order = cand;
          best = c;
          improved = true;
        }
      }
    }
  }
  return order;
}

export const nowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
