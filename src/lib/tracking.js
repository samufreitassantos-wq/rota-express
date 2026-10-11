// Rastreamento por GPS durante a rota: distância real, velocidade real, chegada às paradas
// e tempo real em cada parada. Tudo calculado no aparelho; nada é enviado a servidores.
import { haversine } from './geo.js';

export const MAX_ACCURACY_M = 60; // leituras piores que isso são ignoradas para distância
export const ARRIVAL_RADIUS_M = 50;
export const FAR_FROM_STOP_M = 300; // marcar entrega além disso gera aviso
const MAX_SPEED_MS = 42; // ~150 km/h: acima disso é salto de GPS
const MOVING_SPEED_MS = 1.5; // abaixo disso consideramos parado (entregando, semáforo...)
const MAX_GAP_S = 300; // depois de 5 min sem leitura (app em segundo plano), não soma o tempo

// `last` = última leitura aceita (posição usada no mapa e na previsão); `lastSeen` = última leitura bruta.
export const newTracking = () => ({ active: false, meters: 0, movingMeters: 0, movingSeconds: 0, last: null });

/**
 * Incorpora uma leitura {lat, lng, acc (m), t (ms)} e retorna o novo estado (não altera o original).
 */
export function ingestFix(state, fix) {
  const s = { ...state };
  if (fix.acc > MAX_ACCURACY_M) return { ...s, lastSeen: fix };
  const prev = s.last;
  s.last = fix;
  s.lastSeen = fix;
  if (!prev) return s;
  const dt = (fix.t - prev.t) / 1000;
  if (dt <= 0) {
    s.last = prev;
    return s;
  }
  const d = haversine(prev, fix);
  // Ignora o "tremor" do GPS parado: deslocamento menor que a imprecisão das leituras.
  if (d < Math.max(10, (prev.acc + fix.acc) / 2)) {
    s.last = prev;
    return s;
  }
  if (d / dt > MAX_SPEED_MS) {
    s.last = prev; // salto impossível: descarta esta leitura
    return s;
  }
  s.meters += d;
  if (dt <= MAX_GAP_S && d / dt >= MOVING_SPEED_MS) {
    s.movingMeters += d;
    s.movingSeconds += dt;
  }
  return s;
}

/** Velocidade média real em movimento, depois de dados suficientes (≥ 2 km e ≥ 5 min). */
export function observedSpeedKmh(state) {
  if (!state || state.movingMeters < 2000 || state.movingSeconds < 300) return null;
  return (state.movingMeters / state.movingSeconds) * 3.6;
}

/** Tempo médio real em cada parada (chegada → marcação), com ao menos 3 paradas. */
export function observedServiceMin(stops) {
  const samples = stops
    .filter((s) => s.arrivedAt && s.outcomeAt)
    .map((s) => (Date.parse(s.outcomeAt) - Date.parse(s.arrivedAt)) / 60000)
    .filter((m) => m >= 0 && m <= 60);
  if (samples.length < 3) return null;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return Math.min(30, Math.max(0.5, avg));
}

export const distanceTo = (fix, stop) => haversine(fix, stop);

/** Chegou à parada? Raio mínimo de 50 m, ampliado pela imprecisão da leitura (até 100 m). */
export function isArrived(fix, stop) {
  const radius = Math.min(100, Math.max(ARRIVAL_RADIUS_M, fix.acc ?? 0));
  return distanceTo(fix, stop) <= radius;
}

/** Leitura recente o bastante para basear a previsão (2 min). */
export const isFresh = (fix, now = Date.now()) => !!fix && now - fix.t <= 120000;

export function fmtDistance(m) {
  return m >= 1000 ? `${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`;
}
