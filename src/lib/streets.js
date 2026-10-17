// Rota por RUAS: endereços da mesma rua viram um grupo; a otimização decide só a ordem das ruas
// e, dentro de cada rua, os números seguem em sequência (crescente ou decrescente, começando
// pela ponta mais perto de onde se chega).
import { streetAndNumber } from './addressParser.js';
import { haversine } from './geo.js';

const SAME_STREET_MAX_M = 3000; // mesmo nome a mais de 3 km de todas as outras = outra rua (outro bairro)

const norm = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Rua, número (texto e valor numérico), chave do nome da rua e cidade (quando escrita). */
export function streetInfo(address) {
  const p = streetAndNumber(address) ?? { street: String(address ?? ''), number: '', city: '' };
  const n = parseInt(p.number, 10);
  return {
    street: p.street,
    number: p.number,
    numberValue: Number.isFinite(n) ? n : null,
    key: norm(p.street),
    city: norm(p.city),
  };
}

const hasPoint = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);

/**
 * Agrupa paradas por rua, na ordem em que cada rua aparece pela 1ª vez.
 * Paradas com o mesmo nome de rua mas longe umas das outras (mesmo nome em outro bairro)
 * ficam em grupos separados.
 * @returns [{ key, street, stops }]
 */
export function groupByStreet(stops) {
  const groups = [];
  for (const s of stops) {
    const info = streetInfo(s.address);
    // Mesmo nome; cidade igual quando as duas foram escritas; perto de alguma parada do grupo.
    const g = groups.find((x) => x.key === info.key
      && (!info.city || !x.city || info.city === x.city)
      && (!hasPoint(s) || x.stops.some((o) => !hasPoint(o) || haversine(o, s) <= SAME_STREET_MAX_M)));
    if (g) {
      g.stops.push(s);
      g.city ||= info.city;
    } else groups.push({ key: info.key, city: info.city, street: info.street, stops: [s] });
  }
  return groups;
}

/** Ponto representativo da rua (média das paradas localizadas). */
export function groupPoint(g) {
  const pts = g.stops.filter(hasPoint);
  if (!pts.length) return null;
  return { lat: pts.reduce((a, s) => a + s.lat, 0) / pts.length, lng: pts.reduce((a, s) => a + s.lng, 0) / pts.length };
}

/**
 * Ordem dos números dentro da rua: sequência numérica, no sentido que começa mais perto de `from`
 * (quando as posições são precisas; com posição só da rua, crescente). Sem número vão para o fim.
 */
export function orderWithinStreet(stops, from) {
  const info = new Map(stops.map((s) => [s, streetInfo(s.address).numberValue]));
  const withNum = stops.filter((s) => info.get(s) != null).sort((a, b) => info.get(a) - info.get(b));
  const without = stops.filter((s) => info.get(s) == null);
  if (from && withNum.length > 1) {
    const first = withNum[0];
    const last = withNum[withNum.length - 1];
    const precise = (s) => hasPoint(s) && s.precise !== false;
    if (precise(first) && precise(last) && haversine(from, last) + 1 < haversine(from, first)) withNum.reverse();
  }
  return [...withNum, ...without];
}

/** Junta grupos já ordenados numa lista de paradas, ordenando os números de cada rua. */
export function expandGroups(groups, start) {
  const out = [];
  let from = start;
  for (const g of groups) {
    const ordered = orderWithinStreet(g.stops, from);
    out.push(...ordered);
    const last = ordered.filter(hasPoint).at(-1);
    if (last) from = last;
  }
  return out;
}

/** Janela de horário de uma rua: a mais apertada entre as das suas paradas. */
export function groupWindow(windows) {
  const ws = windows.filter(Boolean);
  if (!ws.length) return null;
  const end = Math.min(...ws.map((w) => w.end));
  const start = Math.max(...ws.map((w) => w.start));
  // Janelas que não se cruzam: vale chegar a tempo da que fecha primeiro.
  return { start: start <= end ? start : Math.min(...ws.map((w) => w.start)), end };
}

/**
 * Quebra a lista (na ordem de visita) em trechos consecutivos da mesma rua — usado na tela.
 * @returns [{ key, street, stops }]
 */
export function streetRuns(stops) {
  const runs = [];
  for (const s of stops) {
    const info = streetInfo(s.address);
    const prev = runs.at(-1);
    if (prev && prev.key === info.key) prev.stops.push(s);
    else runs.push({ key: info.key, street: info.street, stops: [s] });
  }
  return runs;
}

/**
 * Move a rua `from` (índice em `runs`) para a posição `to` e devolve a nova ordem de ids.
 * `runs` = listas de ids por rua, na ordem atual.
 */
export function moveStreet(runs, from, to) {
  const next = runs.slice();
  const [r] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, r);
  return next.flat();
}

/** Inverte o sentido dos números de uma rua (ex.: começar pelo fim da rua). */
export function reverseStreet(runs, idx) {
  return runs.map((r, i) => (i === idx ? r.slice().reverse() : r)).flat();
}
