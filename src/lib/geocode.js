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

const UF_RE = /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/i;
const CEP_ANY = /\b\d{5}-?\d{3}\b/;
const NUM_ONLY = /^(n[º°o]?\.?\s*)?(\d{1,6}[A-Za-z]?)$/i;

/** Rua e número de um endereço ("Rua X, 10 - Bairro, Cidade - UF, CEP" ou "Rua X 10 apto 2"). */
export function streetAndNumber(address) {
  const parts = String(address ?? '').replace(CEP_ANY, ' ').split(/\s*,\s*|\s+[-–]\s+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let street = parts[0];
  let number = '';
  let rest = parts.slice(1);
  // Número dentro da 1ª parte, mas não o de nomes como "Rua 25 de Março" / "Rua 7 de Setembro".
  for (const m of street.matchAll(/\s(\d{1,6}[A-Za-z]?)(?=\s|$)/g)) {
    const before = street.slice(0, m.index).trim();
    const after = street.slice(m.index + m[0].length);
    if (/\s/.test(before) && !/^\s+(de|do|da|dos|das|e)\b/i.test(after)) {
      [street, number] = [before, m[1]];
      break;
    }
  }
  if (!number && NUM_ONLY.test(rest[0] ?? '')) {
    number = rest[0].match(NUM_ONLY)[2];
    rest = rest.slice(1);
  }
  const uf = rest.find((p) => UF_RE.test(p));
  const names = rest.filter((p) => !UF_RE.test(p) && !/^\d/.test(p) && !/^(brasil|brazil)$/i.test(p));
  // Com bairro e cidade, a cidade é o último nome; um nome só pode ser bairro ou cidade.
  const city = names.length >= 2 ? names[names.length - 1] : '';
  return { street, number, city, maybeCity: names.length === 1 ? names[0] : '', uf: uf?.toUpperCase() ?? '' };
}

/**
 * Buscas a tentar, em ordem. A principal é só RUA + NÚMERO (+ cidade, para não cair numa rua de
 * mesmo nome em outra cidade): o Nominatim só acha o endereço se TODAS as palavras baterem com o
 * OpenStreetMap, e no Brasil o OSM raramente tem CEP e muitas vezes não liga a rua ao bairro —
 * por isso "Rua X, 10 - Bairro, Cidade, 00000-000" (planilha) falhava e "Rua X, 10" achava.
 * Bairro e CEP continuam no endereço exibido e enviado ao Google Maps/Waze.
 */
export function queryVariants(address, defaultCity) {
  const p = streetAndNumber(address);
  const out = [];
  if (p) {
    const base = p.number ? `${p.street}, ${p.number}` : p.street;
    const cities = [
      p.city && `${p.city}${p.uf ? ` - ${p.uf}` : ''}`,
      p.maybeCity && `${p.maybeCity}${p.uf ? ` - ${p.uf}` : ''}`,
      // A cidade padrão só entra se a planilha/texto não trouxe a cidade (nunca troca Curitiba por SP).
      !p.city && defaultCity,
      !p.city && !p.maybeCity && p.uf,
    ].filter(Boolean);
    for (const c of cities) out.push(`${base}, ${c}`);
    if (!cities.length) out.push(base);
  }
  out.push(buildQuery(address, defaultCity)); // endereço completo, como antes
  if (p?.number) {
    const c = p.city || p.maybeCity || defaultCity;
    out.push(c ? `${p.street}, ${c}` : p.street); // só a rua: posição aproximada (meio da rua)
  }
  return [...new Set(out.map((q) => q.replace(/\s+/g, ' ').trim()))].filter(Boolean);
}

export async function geocode(address, { key, defaultCity, focus, fetchImpl } = {}) {
  const variants = queryVariants(address, defaultCity);
  const cache = load(CACHE_KEY, {});
  const cacheId = `v3|${variants[0].toLowerCase()}`;
  if (cache[cacheId]) return cache[cacheId];
  let result = null;
  for (const [i, query] of variants.entries()) {
    result = key ? await orsGeocode(query, { key, focus, fetchImpl }) : await nominatim(query, fetchImpl);
    if (result) {
      // Achado só pela rua (sem o número): avisar que a posição é aproximada.
      if (i === variants.length - 1 && i > 0 && streetAndNumber(address)?.number) result = { ...result, precise: false };
      break;
    }
  }
  if (result) {
    cache[cacheId] = result;
    const keys = Object.keys(cache);
    if (keys.length > 2000) delete cache[keys[0]];
    save(CACHE_KEY, cache);
  }
  return result;
}
