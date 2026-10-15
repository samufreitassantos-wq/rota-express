// Identificação das colunas de uma planilha (qualquer modelo) e montagem dos endereços.
// 1) Procura a linha de cabeçalho comparando os títulos com sinônimos (pt/en, sem acento,
//    aceitando títulos cortados como "Destination A").
// 2) Sem cabeçalho reconhecível, olha o conteúdo: CEP, "Rua/Av. ...", UF.
// 3) Sem coluna de endereço, cada linha inteira passa pelo extrator de texto livre.
import { normalizeAddress, extractAddresses } from './addressParser.js';

export const FIELDS = [
  { key: 'address', label: 'Endereço (rua)' },
  { key: 'number', label: 'Número' },
  { key: 'complement', label: 'Complemento' },
  { key: 'neighborhood', label: 'Bairro' },
  { key: 'city', label: 'Cidade' },
  { key: 'state', label: 'UF' },
  { key: 'zip', label: 'CEP' },
  { key: 'customer', label: 'Cliente' },
  { key: 'phone', label: 'Telefone' },
  { key: 'order', label: 'Pedido' },
  { key: 'notes', label: 'Observação' },
];

const SYNONYMS = {
  address: [
    'endereco', 'endereco completo', 'endereco de entrega', 'endereco entrega', 'endereco do destinatario',
    'endereco destino', 'endereco cliente', 'logradouro', 'rua', 'destino', 'local de entrega',
    'address', 'address line 1', 'address 1', 'address1', 'street', 'street address', 'street name',
    'destination address', 'destination', 'delivery address', 'shipping address', 'ship to address',
    'recipient address', 'full address',
  ],
  number: ['numero', 'num', 'nro', 'no', 'n', 'n o', 'number', 'house number', 'street number', 'numero do endereco'],
  complement: ['complemento', 'compl', 'complement', 'address line 2', 'address 2', 'address2', 'apto', 'apartamento', 'bloco'],
  neighborhood: ['bairro', 'bairro destino', 'district', 'neighborhood', 'neighbourhood', 'suburb', 'distrito'],
  city: ['cidade', 'cidade destino', 'municipio', 'localidade', 'city', 'town', 'destination city'],
  state: ['uf', 'estado', 'state', 'province', 'uf destino'],
  zip: ['cep', 'cep destino', 'cep do destinatario', 'zipcode', 'zip code', 'zip', 'postal code', 'postcode', 'codigo postal', 'destination zipcode'],
  customer: [
    'cliente', 'nome', 'nome do cliente', 'nome cliente', 'destinatario', 'nome do destinatario', 'recebedor',
    'razao social', 'name', 'customer', 'customer name', 'recipient', 'recipient name', 'consignee', 'buyer',
  ],
  phone: ['telefone', 'tel', 'celular', 'fone', 'whatsapp', 'contato', 'phone', 'phone number', 'mobile', 'telephone'],
  order: [
    'pedido', 'numero do pedido', 'n pedido', 'no pedido', 'nr pedido', 'cod pedido', 'nf', 'nota fiscal', 'nfe',
    'order', 'order id', 'order number', 'tracking', 'tracking number', 'rastreio', 'codigo de rastreio',
    'awb', 'id', 'codigo', 'package id', 'shipment id',
  ],
  notes: ['observacao', 'observacoes', 'obs', 'notes', 'note', 'instrucoes', 'referencia', 'ponto de referencia', 'comments', 'comentarios'],
};

// Palavras que, no título, indicam outro campo (evita "Número do pedido" virar número da casa).
const BLOCKERS = {
  number: /\b(pedido|nota|nf|order|telefone|tel|celular|cpf|cnpj|documento|rastreio|tracking|serie|volume)\b/,
  address: /\b(email|e mail|ip|web|site|remetente|sender|origem|origin|cobranca|billing)\b/,
  city: /\b(remetente|sender|origem|origin)\b/,
  zip: /\b(remetente|sender|origem|origin)\b/,
  neighborhood: /\b(remetente|sender|origem|origin)\b/,
  customer: /\b(remetente|sender|vendedor|seller|motorista|driver|entregador)\b/,
};

export const normHeader = (s) => String(s ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[º°ª]/g, ' o ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Pontuação de um título para um campo: 100 exato, 80 título cortado, 60 contém o sinônimo. */
export function headerScore(header, field) {
  const h = normHeader(header);
  if (!h || BLOCKERS[field]?.test(h)) return 0;
  let best = 0;
  for (const syn of SYNONYMS[field]) {
    if (h === syn) return 100;
    if (h.length >= 5 && syn.startsWith(h) && syn.length > h.length) best = Math.max(best, 80);
    else if (syn.length >= 3 && new RegExp(`(^| )${syn}( |$)`).test(h)) best = Math.max(best, 60 + Math.min(syn.length, 15));
  }
  return best;
}

/** Associa colunas a campos (cada coluna e cada campo usados uma vez, pela maior pontuação). */
function mapHeaders(headers) {
  const cands = [];
  headers.forEach((h, col) => {
    for (const { key } of FIELDS) {
      const score = headerScore(h, key);
      if (score) cands.push({ col, key, score });
    }
  });
  cands.sort((a, b) => b.score - a.score || a.col - b.col);
  const mapping = {};
  const usedCols = new Set();
  let total = 0;
  for (const c of cands) {
    if (mapping[c.key] != null || usedCols.has(c.col)) continue;
    mapping[c.key] = c.col;
    usedCols.add(c.col);
    total += c.score;
  }
  return { mapping, total };
}

const STREET_START = /^(rua|r|avenida|av|alameda|al|travessa|tv|trav|rodovia|rod|estrada|estr|est|praca|pca|largo|lg|via|viela|vila|vl|beco|servidao|ladeira|parque|quadra|qd|setor|conjunto|cj|condominio|cond|street|st|avenue|ave|road|rd)\b\.?/i;
const UF_RE = /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/i;

/** CEP brasileiro (aceita número sem o zero à esquerda, como o Excel guarda). */
export function formatCep(v) {
  const s = String(v ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (/^\d{5}-?\d{3}$/.test(s) || /^\d{2}\.?\d{3}-?\d{3}$/.test(s) || /^\d{7,8}$/.test(s)) {
    const d = digits.padStart(8, '0');
    return `${d.slice(0, 5)}-${d.slice(5)}`;
  }
  return null;
}

const isStreet = (v) => v.length >= 6 && STREET_START.test(normHeader(v));

/** Sem cabeçalho: adivinha pelo conteúdo das colunas. */
function mapByContent(rows) {
  const sample = rows.slice(0, 50);
  const ncols = Math.max(0, ...sample.map((r) => r.length));
  const ratio = (col, test) => {
    const vals = sample.map((r) => r[col] ?? '').filter((v) => v !== '');
    return vals.length ? vals.filter(test).length / vals.length : 0;
  };
  const mapping = {};
  const pick = (key, test, min) => {
    let best = -1;
    let bestR = min;
    for (let c = 0; c < ncols; c++) {
      if (Object.values(mapping).includes(c)) continue;
      const r = ratio(c, test);
      if (r > bestR) [best, bestR] = [c, r];
    }
    if (best >= 0) mapping[key] = best;
  };
  pick('address', isStreet, 0.5);
  pick('zip', (v) => formatCep(v) != null, 0.6);
  pick('state', (v) => UF_RE.test(v.trim()), 0.6);
  return mapping;
}

/**
 * Detecta cabeçalho e colunas. Devolve { headerRow, headers, mapping } (headerRow = -1 sem cabeçalho).
 */
export function detectColumns(rows) {
  let best = { headerRow: -1, mapping: {}, total: 0 };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const { mapping, total } = mapHeaders(rows[i]);
    const locating = ['address', 'zip', 'city'].filter((k) => mapping[k] != null).length;
    if (locating && Object.keys(mapping).length >= 2 && total > best.total) best = { headerRow: i, mapping, total };
  }
  if (best.headerRow >= 0) {
    return { headerRow: best.headerRow, headers: rows[best.headerRow], mapping: best.mapping };
  }
  const mapping = mapByContent(rows);
  // Títulos desconhecidos (ex.: "Local"): a 1ª linha não parece endereço, mas a 2ª sim.
  const a = mapping.address;
  if (a != null && rows.length > 1 && !isStreet(rows[0][a] ?? '') && isStreet(rows[1][a] ?? '')) {
    return { headerRow: 0, headers: rows[0], mapping };
  }
  return { headerRow: -1, headers: [], mapping };
}

/** Assinatura dos títulos (para lembrar o mapeamento escolhido para esse modelo de planilha). */
export const headerSignature = (headers) => headers.map(normHeader).join('|').slice(0, 500);

const contains = (hay, needle) => {
  const n = normHeader(needle);
  return n !== '' && ` ${normHeader(hay)} `.includes(` ${n} `);
};

/** Monta o endereço de uma linha: "Rua X, 123 - Bairro, Cidade - UF, 00000-000". */
export function buildAddress(row, mapping) {
  const get = (k) => (mapping[k] != null && mapping[k] >= 0 ? String(row[mapping[k]] ?? '').replace(/\s+/g, ' ').trim() : '');
  let s = get('address');
  const number = get('number');
  if (!s) return '';
  if (number && !contains(s, number)) s += `, ${number}`;
  // Bairro/cidade/UF só contam como já presentes depois do nome da rua
  // ("Rua dos Pinheiros, 320" ainda precisa do bairro Pinheiros).
  const tail = () => {
    const i = s.search(/,|\d/);
    return i < 0 ? '' : s.slice(i);
  };
  const bairro = get('neighborhood');
  if (bairro && !contains(tail(), bairro)) s += ` - ${bairro}`;
  const city = get('city');
  if (city && !contains(tail(), city)) s += `, ${city}`;
  const uf = get('state');
  if (uf && !contains(tail(), uf)) s += ` - ${uf.length === 2 ? uf.toUpperCase() : uf}`;
  const rawZip = get('zip');
  const cep = formatCep(rawZip) ?? rawZip;
  if (cep && !s.replace(/\D/g, '').includes(cep.replace(/\D/g, ''))) s += `, ${cep}`;
  return normalizeAddress(s).slice(0, 300);
}

/** Informações extras da linha que ajudam o entregador (não entram na busca do endereço). */
export function buildRef(row, mapping) {
  const get = (k) => (mapping[k] != null && mapping[k] >= 0 ? String(row[mapping[k]] ?? '').replace(/\s+/g, ' ').trim() : '');
  const parts = [
    get('customer'),
    get('order') && `Pedido ${get('order')}`,
    get('phone') && `Tel. ${get('phone')}`,
    get('complement') && `Compl.: ${get('complement')}`,
    get('notes') && `Obs.: ${get('notes')}`,
  ].filter(Boolean);
  return parts.join(' · ').slice(0, 300);
}

/**
 * Converte as linhas em itens { address, ref } usando o mapeamento.
 * Sem coluna de endereço, cada linha é lida como texto livre.
 */
export function rowsToItems(rows, { headerRow, mapping }) {
  const data = rows.slice(headerRow + 1);
  const items = [];
  let skipped = 0;
  for (const row of data) {
    if (row.every((c) => c === '')) continue;
    let address = '';
    if (mapping.address != null && mapping.address >= 0) address = buildAddress(row, mapping);
    else {
      const found = extractAddresses(row.filter(Boolean).join(', '));
      address = found[0]?.address ?? '';
    }
    if (!address) { skipped++; continue; }
    items.push({ address, ref: buildRef(row, mapping) });
  }
  return { items, skipped };
}

/** Nome exibido de uma coluna: o título ou a letra (A, B, ..., AA). */
export function columnName(headers, col) {
  let n = col + 1;
  let letter = '';
  while (n > 0) { const m = (n - 1) % 26; letter = String.fromCharCode(65 + m) + letter; n = Math.floor((n - 1) / 26); }
  const h = headers?.[col];
  return h ? `${letter} · ${h}` : `Coluna ${letter}`;
}
