// Planejamento da rota: tenta o OpenRouteService e cai para a heurística local se necessário.
import { haversine } from './geo.js';
import { orsOptimize, orsDirections } from './ors.js';
import { optimizeWithWindows, simulate } from './timeWindows.js';
import { groupByStreet, groupPoint, groupWindow, expandGroups } from './streets.js';

/** Ordem de visita dos pontos (ORS com chave; senão/na falha, local). */
async function orderPoints(start, points, { key, fetchImpl, windows = [], startMin, timing = {} }, warnings) {
  if (key) {
    try {
      const r = await orsOptimize(start, points, { key, fetchImpl, windows, startMin, serviceMin: timing.serviceMin });
      if (r.unassigned) warnings.push(`${r.unassigned} parada(s) não couberam na janela de horário e foram para o fim da rota.`);
      return { order: r.order, method: 'ors' };
    } catch (e) {
      warnings.push(`Otimização ORS indisponível (${e.message}). Usada otimização local.`);
    }
  }
  return { order: optimizeWithWindows([start, ...points], [null, ...windows], startMin, timing).map((i) => i - 1), method: 'local' };
}

/** Traçado e distância: pelas ruas (ORS) quando possível; senão, linhas retas. */
async function routeLine(points, { key, fetchImpl }, warnings) {
  let geometry = points.map((p) => [p.lat, p.lng]);
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]);
  if (key) {
    try {
      const d = await orsDirections(points, { key, fetchImpl });
      return { geometry: d.coords, distance: d.distance, duration: d.duration, roadGeometry: true };
    } catch (e) {
      warnings.push(`Traçado pelas ruas indisponível (${e.message}). Exibindo linhas retas.`);
    }
  }
  return { geometry, distance, duration: null, roadGeometry: false };
}

function lateWarning(start, stops, windows, startMin, timing, warnings) {
  if (!windows.some(Boolean)) return;
  const sim = simulate([start, ...stops], [null, ...windows], startMin, timing);
  if (sim.lateCount) warnings.push(`Previsão: ${sim.lateCount} parada(s) chegariam depois do fim da janela de horário.`);
}

/**
 * Rota parada a parada.
 * @param start {lat,lng}
 * @param stops [{lat,lng,...}] já geocodificadas
 * @param windows windows[i] = {start,end} (minutos) para stops[i], ou null
 * @param startMin hora de saída (minutos desde 00:00); timing = {speedKmh, serviceMin}
 * @returns {order:number[], method:string, geometry:[[lat,lng]], distance:number, duration:number|null, warnings:string[]}
 */
export async function planRoute(start, stops, { key, fetchImpl, windows = [], startMin = 480, timing = {} } = {}) {
  const warnings = [];
  const { order, method } = await orderPoints(start, stops, { key, fetchImpl, windows, startMin, timing }, warnings);
  lateWarning(start, order.map((i) => stops[i]), order.map((i) => windows[i]), startMin, timing, warnings);
  const line = await routeLine([start, ...order.map((i) => stops[i])], { key, fetchImpl }, warnings);
  return { order, method, ...line, warnings };
}

/**
 * Rota por ruas: agrupa os endereços da mesma rua, otimiza só a ordem das ruas e percorre
 * os números de cada rua em sequência. Mesmo formato de retorno de planRoute, mais `streets`.
 */
export async function planStreetRoute(start, stops, { key, fetchImpl, windows = [], startMin = 480, timing = {} } = {}) {
  const warnings = [];
  const idx = new Map(stops.map((s, i) => [s, i]));
  const groups = groupByStreet(stops).filter((g) => groupPoint(g));
  const points = groups.map(groupPoint);
  const gWindows = groups.map((g) => groupWindow(g.stops.map((s) => windows[idx.get(s)])));
  const { order: gOrder, method } = await orderPoints(start, points, { key, fetchImpl, windows: gWindows, startMin, timing }, warnings);
  const visit = expandGroups(gOrder.map((i) => groups[i]), start);
  const order = visit.map((s) => idx.get(s));
  lateWarning(start, visit, order.map((i) => windows[i]), startMin, timing, warnings);
  const line = await routeLine([start, ...visit], { key, fetchImpl }, warnings);
  return { order, method, streets: groups.length, ...line, warnings };
}
