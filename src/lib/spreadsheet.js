// Leitura de planilhas no próprio aparelho: Excel (.xlsx/.xlsm), LibreOffice/OpenOffice (.ods),
// CSV/TSV (inclusive o que se copia do Google Planilhas). Sem bibliotecas de planilha de terceiros:
// só o descompactador fflate e um leitor de XML mínimo, que não resolve entidades externas (sem XXE)
// e percorre o texto de forma linear (sem regex com retrocesso sobre o conteúdo do arquivo).
import { unzipSync } from 'fflate';

export const LIMITS = {
  fileBytes: 15 * 1024 * 1024, // arquivo enviado
  entryBytes: 60 * 1024 * 1024, // cada XML descompactado (proteção contra "zip bomb")
  rows: 5000,
  cols: 100,
};

const XLSX_ENTRY_RE = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/;
const ODS_ENTRY_RE = /^(content\.xml|mimetype)$/;

export class SpreadsheetError extends Error {}

export function isSpreadsheetName(name) {
  return /\.(xlsx|xlsm|ods|csv|tsv|txt|xls|numbers)$/i.test(String(name ?? ''));
}

/** Lê um File/Blob de planilha e devolve { sheets: [{ name, rows: string[][] }] }. */
export async function readSpreadsheet(file) {
  if (file.size > LIMITS.fileBytes) throw new SpreadsheetError('Planilha muito grande (máximo 15 MB).');
  const name = String(file.name ?? '').toLowerCase();
  if (name.endsWith('.numbers')) {
    throw new SpreadsheetError('Arquivo do Numbers: exporte como Excel (.xlsx) ou CSV e importe de novo.');
  }
  return readSpreadsheetBytes(new Uint8Array(await file.arrayBuffer()), name);
}

export function readSpreadsheetBytes(bytes, name = '') {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readZipSheet(bytes);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new SpreadsheetError(
      'Formato .xls antigo ou planilha protegida por senha: abra no Excel/Google Planilhas, salve como .xlsx (sem senha) ou .csv e importe de novo.',
    );
  }
  const text = decodeText(bytes);
  return { sheets: [{ name: 'Planilha', rows: parseDelimited(text, /\.tsv$/i.test(name) ? '\t' : undefined) }] };
}

/** UTF-8 quando válido; senão Windows-1252 (CSV salvo pelo Excel em português). */
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ---------- CSV / TSV ----------
const DELIMS = [',', ';', '\t', '|'];

function detectDelimiter(text) {
  const lines = [];
  let i = 0;
  while (lines.length < 20 && i < text.length) {
    const j = text.indexOf('\n', i);
    const line = text.slice(i, j < 0 ? text.length : j);
    if (line.trim()) lines.push(line);
    i = j < 0 ? text.length : j + 1;
  }
  let best = ',';
  let bestScore = 0;
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const withDelim = counts.filter((c) => c > 0);
    if (!withDelim.length) continue;
    // Prefere o separador presente em mais linhas e com contagem estável.
    const mode = mostCommon(withDelim);
    const score = counts.filter((c) => c === mode).length * 10 + withDelim.length + (d === '\t' ? 0.5 : 0);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

function countOutsideQuotes(line, d) {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

function mostCommon(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** CSV/TSV no padrão RFC 4180 (aspas, aspas duplicadas, quebras de linha dentro de aspas). */
export function parseDelimited(text, delimiter) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(s);
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= LIMITS.rows + 50) break;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return tidy(rows);
}

/** Texto colado parece uma tabela (copiada de Excel/Google Planilhas: colunas separadas por TAB)? */
export function looksTabular(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const withTabs = lines.filter((l) => l.includes('\t')).length;
  return withTabs / lines.length >= 0.6;
}

// ---------- XML mínimo ----------
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXml(s) {
  return String(s)
    .replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
      return ENTITIES[e] ?? m;
    });
}

/** Remove prefixos de namespace das tags (<x:c>, <table:table-cell>) para simplificar a leitura. */
const stripPrefixes = (xml) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

function attrs(s) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = decodeXml(m[2] ?? m[3]);
  return out;
}

/**
 * Percorre os elementos <tag> (não aninhados entre si) de forma linear.
 * Se uma tag não fecha, para (arquivo truncado/malformado) em vez de varrer o resto de novo.
 */
function* elements(xml, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  while (true) {
    const start = xml.indexOf(open, i);
    if (start < 0) return;
    const after = xml[start + open.length];
    if (after !== ' ' && after !== '>' && after !== '/' && after !== '\t' && after !== '\n' && after !== '\r') {
      i = start + open.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0) return;
    const selfClosing = xml[tagEnd - 1] === '/';
    const attrText = xml.slice(start + open.length, selfClosing ? tagEnd - 1 : tagEnd);
    if (selfClosing) {
      yield { attrs: attrs(attrText), inner: '' };
      i = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd);
    if (end < 0) return;
    yield { attrs: attrs(attrText), inner: xml.slice(tagEnd + 1, end) };
    i = end + close.length;
  }
}

function removeElements(xml, tag) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = xml.indexOf(`<${tag}`, i);
    if (start < 0) break;
    const end = xml.indexOf(`</${tag}>`, start);
    if (end < 0) break;
    out += xml.slice(i, start);
    i = end + tag.length + 3;
  }
  return out + xml.slice(i);
}

const texts = (xml, tag) => [...elements(xml, tag)].map((e) => decodeXml(e.inner.replace(/<[^>]*>/g, '')));

// ---------- XLSX / ODS ----------
function readZipSheet(bytes) {
  let files;
  try {
    files = unzipSync(bytes, {
      filter: (f) => (XLSX_ENTRY_RE.test(f.name) || ODS_ENTRY_RE.test(f.name)) && f.originalSize <= LIMITS.entryBytes,
    });
  } catch {
    throw new SpreadsheetError('Não foi possível abrir a planilha (arquivo corrompido?).');
  }
  const utf8 = new TextDecoder('utf-8');
  const xml = (n) => (files[n] ? stripPrefixes(utf8.decode(files[n])) : null);
  if (files['xl/workbook.xml']) return readXlsx(xml, Object.keys(files));
  if (files['content.xml']) return readOds(xml('content.xml'));
  throw new SpreadsheetError('Arquivo compactado não reconhecido como planilha (.xlsx ou .ods).');
}

function readXlsx(xml, names) {
  const shared = xml('xl/sharedStrings.xml');
  // Texto de cada <si>: <t> simples ou trechos formatados <r><t>; ignora a fonética (<rPh>).
  const strings = shared ? [...elements(shared, 'si')].map((si) => texts(removeElements(si.inner, 'rPh'), 't').join('')) : [];
  const rels = {};
  for (const r of elements(xml('xl/_rels/workbook.xml.rels') ?? '', 'Relationship')) {
    rels[r.attrs.Id] = r.attrs.Target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  const wb = xml('xl/workbook.xml');
  let sheets = [...elements(wb, 'sheet')].map((s) => ({
    name: s.attrs.name || 'Planilha',
    path: rels[s.attrs['r:id']] ?? rels[s.attrs.id],
    hidden: s.attrs.state === 'hidden' || s.attrs.state === 'veryHidden',
  }));
  if (!sheets.some((s) => s.path && names.includes(s.path))) {
    sheets = names.filter((n) => n.startsWith('xl/worksheets/')).sort().map((path, i) => ({ name: `Planilha ${i + 1}`, path }));
  }
  const out = [];
  for (const s of sheets) {
    if (s.hidden || !s.path || !names.includes(s.path)) continue;
    const rows = tidy(parseXlsxSheet(xml(s.path), strings));
    if (rows.length) out.push({ name: s.name, rows });
  }
  return { sheets: out };
}

function colIndex(ref) {
  const m = /^([A-Z]{1,3})/.exec(ref ?? '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function fmtNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

function parseXlsxSheet(xml, strings) {
  const rows = [];
  for (const row of elements(xml, 'row')) {
    const r = Number(row.attrs.r) - 1;
    const idx = Number.isInteger(r) && r >= 0 ? r : rows.length;
    if (idx >= LIMITS.rows + 50) break;
    const cells = [];
    let next = 0;
    for (const c of elements(row.inner, 'c')) {
      const ci = c.attrs.r ? colIndex(c.attrs.r) : next;
      next = ci + 1;
      if (ci < 0 || ci >= LIMITS.cols) continue;
      const t = c.attrs.t;
      const v = [...elements(c.inner, 'v')][0];
      const raw = v ? decodeXml(v.inner) : '';
      let val;
      if (t === 's') val = strings[Number(raw)] ?? '';
      else if (t === 'inlineStr') val = texts(c.inner, 't').join('');
      else if (t === 'str' || t === 'e') val = raw;
      else if (t === 'b') val = raw === '1' ? 'VERDADEIRO' : 'FALSO';
      else val = raw === '' ? '' : fmtNumber(raw);
      cells[ci] = unescapeOoxml(val);
    }
    rows[idx] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x ?? []);
}

/** Excel codifica alguns caracteres de controle como _x000D_. */
const unescapeOoxml = (s) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

function readOds(xml) {
  const out = [];
  for (const table of elements(xml, 'table')) {
    const rows = [];
    for (const row of elements(table.inner, 'table-row')) {
      const cells = [];
      for (const cell of cellsOf(row.inner)) {
        const rep = Math.max(1, Number(cell.attrs['table:number-columns-repeated']) || 1);
        const val = odsValue(cell);
        // Repetições longas (até o fim da planilha) param no limite de colunas.
        const n = Math.min(rep, LIMITS.cols - cells.length);
        for (let k = 0; k < n; k++) cells.push(val);
        if (cells.length >= LIMITS.cols) break;
      }
      const rep = Math.max(1, Number(row.attrs['table:number-rows-repeated']) || 1);
      const empty = cells.every((c) => c === '');
      const n = empty ? Math.min(rep, 1) : Math.min(rep, LIMITS.rows + 50 - rows.length);
      for (let k = 0; k < n; k++) rows.push(cells);
      if (rows.length >= LIMITS.rows + 50) break;
    }
    const t = tidy(rows);
    if (t.length) out.push({ name: table.attrs['table:name'] || 'Planilha', rows: t });
  }
  return { sheets: out };
}

/** Células de uma linha ODS, incluindo as "cobertas" por mesclagem, na ordem. */
function* cellsOf(rowXml) {
  const all = [];
  for (const tag of ['table-cell', 'covered-table-cell']) {
    let pos = 0;
    for (const c of elements(rowXml, tag)) {
      pos = rowXml.indexOf(`<${tag}`, pos);
      all.push({ pos, ...c });
      pos += 1;
    }
  }
  all.sort((a, b) => a.pos - b.pos);
  yield* all;
}

function odsValue(cell) {
  const type = cell.attrs['office:value-type'];
  if ((type === 'float' || type === 'percentage' || type === 'currency') && cell.attrs['office:value'] != null) {
    return fmtNumber(cell.attrs['office:value']);
  }
  const inner = removeElements(cell.inner, 'annotation');
  return [...elements(inner, 'p')]
    .map((p) => decodeXml(
      p.inner
        .replace(/<s\b[^>]*?c="(\d{1,3})"[^>]*\/>/g, (m, n) => ' '.repeat(Number(n)))
        .replace(/<s\b[^>]*\/>/g, ' ')
        .replace(/<tab\b[^>]*\/>/g, '\t')
        .replace(/<line-break\b[^>]*\/>/g, '\n')
        .replace(/<[^>]*>/g, ''),
    ))
    .join('\n');
}

/** Tira espaços das células, remove linhas vazias do fim e limita o tamanho. */
function tidy(rows) {
  const out = rows.slice(0, LIMITS.rows + 50).map((r) => (r ?? []).slice(0, LIMITS.cols).map((c) => String(c ?? '').trim()));
  while (out.length && out[out.length - 1].every((c) => c === '')) out.pop();
  return out;
}
