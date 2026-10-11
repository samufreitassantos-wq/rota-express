// Utilidades geográficas e heurística local de otimização (sem rede).

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Distância em metros entre dois pontos {lat, lng}. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function distanceMatrix(points) {
  return points.map((p) => points.map((q) => haversine(p, q)));
}

/** Custo de um caminho aberto que começa em 0 e visita `order` (índices na matriz). */
export function pathCost(matrix, order) {
  let cost = 0;
  let prev = 0;
  for (const i of order) {
    cost += matrix[prev][i];
    prev = i;
  }
  return cost;
}

/**
 * Ordena as paradas a partir do ponto inicial (índice 0 da matriz):
 * vizinho mais próximo + melhoria 2-opt em caminho aberto.
 * Retorna os índices (1..n) na ordem de visita.
 */
export function optimizeOrder(matrix, { maxPasses = 50 } = {}) {
  const n = matrix.length - 1;
  if (n <= 0) return [];
  const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
  const order = [];
  let cur = 0;
  while (left.size) {
    let best = null;
    for (const j of left) if (best === null || matrix[cur][j] < matrix[cur][best]) best = j;
    order.push(best);
    left.delete(best);
    cur = best;
  }

  // 2-opt: inverte o trecho order[i..k] se reduzir o custo do caminho aberto.
  const path = [0, ...order];
  for (let pass = 0, improved = true; improved && pass < maxPasses; pass++) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const a = path[i - 1], b = path[i], c = path[k], d = path[k + 1];
        const before = matrix[a][b] + (d !== undefined ? matrix[c][d] : 0);
        const after = matrix[a][c] + (d !== undefined ? matrix[b][d] : 0);
        if (after + 1e-9 < before) {
          path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path.slice(1);
}
