// Planejamento da rota: tenta o OpenRouteService e cai para a heurística local se necessário.
import { haversine } from './geo.js';
import { orsOptimize, orsDirections } from './ors.js';
import { optimizeWithWindows, simulate } from './timeWindows.js';

/**
 * @param start {lat,lng}
 * @param stops [{lat,lng,...}] já geocodificadas
 * @param windows windows[i] = {start,end} (minutos) para stops[i], ou null
 * @param startMin hora de saída (minutos desde 00:00); timing = {speedKmh, serviceMin}
 * @returns {order:number[], method:string, geometry:[[lat,lng]], distance:number, duration:number|null, warnings:string[]}
 */
export async function planRoute(start, stops, { key, fetchImpl, windows = [], startMin = 480, timing = {} } = {}) {
  const warnings = [];
  let order = null;
  let method = 'local';

  if (key) {
    try {
      const r = await orsOptimize(start, stops, { key, fetchImpl, windows, startMin, serviceMin: timing.serviceMin });
      order = r.order;
      method = 'ors';
      if (r.unassigned) warnings.push(`${r.unassigned} parada(s) não couberam na janela de horário e foram para o fim da rota.`);
    } catch (e) {
      warnings.push(`Otimização ORS indisponível (${e.message}). Usada otimização local.`);
    }
  }
  if (!order) order = optimizeWithWindows([start, ...stops], [null, ...windows], startMin, timing).map((i) => i - 1);

  if (windows.some(Boolean)) {
    const sim = simulate([start, ...order.map((i) => stops[i])], [null, ...order.map((i) => windows[i])], startMin, timing);
    if (sim.lateCount) warnings.push(`Previsão: ${sim.lateCount} parada(s) chegariam depois do fim da janela de horário.`);
  }

  const points = [start, ...order.map((i) => stops[i])];
  let geometry = points.map((p) => [p.lat, p.lng]);
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]);
  let duration = null;
  let roadGeometry = false;

  if (key) {
    try {
      const d = await orsDirections(points, { key, fetchImpl });
      geometry = d.coords;
      distance = d.distance;
      duration = d.duration;
      roadGeometry = true;
    } catch (e) {
      warnings.push(`Traçado pelas ruas indisponível (${e.message}). Exibindo linhas retas.`);
    }
  }
  return { order, method, geometry, distance, duration, roadGeometry, warnings };
}
