// Extração e normalização de endereços brasileiros a partir de texto livre (ex.: texto de PDF).

const STREET_TYPES = [
  ['r', 'Rua'], ['rua', 'Rua'],
  ['av', 'Avenida'], ['avenida', 'Avenida'],
  ['al', 'Alameda'], ['alameda', 'Alameda'],
  ['tv', 'Travessa'], ['trav', 'Travessa'], ['travessa', 'Travessa'],
  ['rod', 'Rodovia'], ['rodovia', 'Rodovia'],
  ['est', 'Estrada'], ['estr', 'Estrada'], ['estrada', 'Estrada'],
  ['pc', 'Praça'], ['pca', 'Praça'], ['praca', 'Praça'], ['praça', 'Praça'],
  ['lg', 'Largo'], ['largo', 'Largo'],
  ['vl', 'Vila'], ['vila', 'Vila'],
  ['cond', 'Condomínio'], ['condominio', 'Condomínio'], ['condomínio', 'Condomínio'],
];
const STREET_MAP = new Map(STREET_TYPES);
const STREET_RE = new RegExp(
  `(?<![\\p{L}\\d])(${STREET_TYPES.map(([k]) => k).join('|')})\\.?\\s+(?=\\S)`,
  'iu',
);
export const CEP_RE = /\b(\d{5})-?(\d{3})\b/;
const UF = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';
const CITY_UF_RE = new RegExp(`([A-Za-zÀ-ÿ' .]+?)\\s*[-/,]\\s*(${UF})\\b`);

/** Normaliza espaços, abreviações do logradouro e formato do CEP. */
export function normalizeAddress(raw) {
  let s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .trim()
    .replace(/^[,;:\-–\s]+|[,;:\-–\s]+$/g, '');

  s = s.replace(/^(\p{L}+)\.?\s+/u, (m, word) => {
    const full = STREET_MAP.get(word.toLowerCase());
    return full ? `${full} ` : m;
  });
  s = s.replace(/\b(n[º°o]\.?|num\.?|número)\s*(?=\d)/gi, '');
  s = s.replace(CEP_RE, '$1-$2');
  return s;
}

/** Retorna o CEP (00000-000) presente no texto, ou null. */
export function extractCep(text) {
  const m = String(text).match(CEP_RE);
  return m ? `${m[1]}-${m[2]}` : null;
}

function looksLikeAddress(line) {
  return STREET_RE.test(line) && /\d/.test(line);
}

/**
 * Extrai endereços de um texto com várias linhas.
 * Uma linha com tipo de logradouro + número inicia um endereço; linhas seguintes
 * com bairro/cidade/UF/CEP (sem novo logradouro) são anexadas a ele.
 */
export function extractAddresses(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const results = [];
  let current = null;
  const flush = () => {
    if (current) results.push(current);
    current = null;
  };

  for (const line of lines) {
    if (looksLikeAddress(line)) {
      flush();
      current = { lines: [line.slice(line.match(STREET_RE).index)], extra: 0 };
      continue;
    }
    if (current && current.extra < 2 && (CEP_RE.test(line) || CITY_UF_RE.test(line) || /^bairro\b/i.test(line))) {
      current.lines.push(line.replace(/^bairro\s*:?\s*/i, ''));
      current.extra += 1;
      continue;
    }
    flush();
  }
  flush();

  const seen = new Set();
  return results
    .map((r) => normalizeAddress(r.lines.join(', ')))
    .filter((a) => {
      const key = a.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((address) => ({ address, cep: extractCep(address) }));
}
