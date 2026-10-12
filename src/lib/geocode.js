// Geocodificação com cache local. Usa ORS quando há chave; senão Nominatim (OSM, gratuito,
// limite de 1 requisição/segundo — adequado para uso pessoal de baixo volume).
import { orsGeocode } from './ors.js';
import { load, save } from './storage.js';

// v2: resultados passaram a indicar se o número da casa foi encontrado (precise).
const CACHE_KEY = 'geocache2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;

async function nominatim(text, fetchImpl = fetch) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: text, format: 'jsonv2', countrycodes: 'br', limit: '1', addressdetails: '1', 'accept-language': 'pt-BR' });
  const res = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  // Sem número da casa no OpenStreetMap, o ponto é o meio da rua (posição aproximada).
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name, confidence: null, precise: Boolean(hit.address?.house_number) } : null;
}

/** Monta o texto de busca, acrescentando a cidade padrão se o endereço não tiver cidade/CEP. */
export function buildQuery(address, defaultCity) {
  const hasLocality = /\b\d{5}-?\d{3}\b/.test(address) || /[-/,]\s*[A-Z]{2}\b/.test(address);
  return defaultCity && !hasLocality ? `${address}, ${defaultCity}` : address;
}

export async function geocode(address, { key, defaultCity, focus, fetchImpl } = {}) {
  const query = buildQuery(address, defaultCity);
  const cache = load(CACHE_KEY, {});
  const cacheId = query.toLowerCase();
  if (cache[cacheId]) return cache[cacheId];
  const result = key ? await orsGeocode(query, { key, focus, fetchImpl }) : await nominatim(query, fetchImpl);
  if (result) {
    cache[cacheId] = result;
    const keys = Object.keys(cache);
    if (keys.length > 2000) delete cache[keys[0]];
    save(CACHE_KEY, cache);
  }
  return result;
}
