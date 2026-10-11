// Planejamento da rota: tenta o OpenRouteService e cai para a heurística local se necessário.
import { distanceMatrix, optimizeOrder, haversine } from './geo.js';
import { orsOptimize, orsDirections } from './ors.js';

/**
 * @param start {lat,lng}
 * @param stops [{lat,lng,...}] já geocodificadas
 * @returns {order:number[], method:string, geometry:[[lat,lng]], distance:number, duration:number|null, warnings:string[]}
 */
export async function planRoute(start, stops, { key, fetchImpl } = {}) {
  const warnings = [];
  let order = null;
  let method = 'local';

  if (key) {
    try {
      order = await orsOptimize(start, stops, { key, fetchImpl });
      method = 'ors';
    } catch (e) {
      warnings.push(`Otimização ORS indisponível (${e.message}). Usada otimização local.`);
    }
  }
  if (!order) order = optimizeOrder(distanceMatrix([start, ...stops])).map((i) => i - 1);

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
