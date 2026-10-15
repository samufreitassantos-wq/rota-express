import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { readSpreadsheetBytes, parseDelimited, looksTabular, decodeText, SpreadsheetError } from '../src/lib/spreadsheet.js';
import { detectColumns, rowsToItems, buildAddress, formatCep, headerScore, columnName } from '../src/lib/columns.js';

const fixture = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

const EXPECTED = [
  'Rua Augusta, 1500 - Consolação, São Paulo, 01305-100',
  'Avenida Paulista 1000 - Bela Vista, São Paulo, 01310-100',
  'Rua dos Pinheiros 320 apto 12 - Pinheiros, São Paulo, 05422-000',
];

function importRows(rows) {
  const det = detectColumns(rows);
  return { det, ...rowsToItems(rows, det) };
}

describe('planilhas reais (Excel/openpyxl, LibreOffice .ods e .xlsx)', () => {
  for (const file of ['modelo-destination.xlsx', 'modelo-destination.ods', 'modelo-libreoffice.xlsx']) {
    it(`lê ${file} e acha as colunas Destination Address/Bairro/City/ZipCode`, () => {
      const { sheets } = readSpreadsheetBytes(fixture(file), file);
      expect(sheets[0].name).toBe('Rotas');
      expect(sheets.some((s) => s.name === 'Vazia')).toBe(false);
      const { det, items, skipped } = importRows(sheets[0].rows);
      expect(det.headerRow).toBe(2);
      expect(det.mapping).toMatchObject({ address: 2, neighborhood: 3, city: 4, zip: 5, customer: 6, phone: 7, order: 1 });
      expect(items.map((i) => i.address)).toEqual(EXPECTED);
      expect(items[0].ref).toBe('Ana & Cia <b> · Pedido PED-001 · Tel. 11 99999-0000');
      expect(skipped).toBe(1);
    });
  }
});

function makeXlsx(sheetXml, { shared = null, prefix = '' } = {}) {
  const p = prefix ? `${prefix}:` : '';
  const files = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<${p}workbook xmlns:r="r"><${p}sheets><${p}sheet name="Dados &amp; CEP" sheetId="1" r:id="rId1"/></${p}sheets></${p}workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
  };
  if (shared) files['xl/sharedStrings.xml'] = strToU8(shared);
  return zipSync(files);
}

describe('xlsx', () => {
  it('lê texto compartilhado com formatação, texto embutido, células puladas e prefixos de namespace', () => {
    const shared = '<sst><si><t>CEP</t></si><si><r><t>Ende</t></r><r><t xml:space="preserve">reço</t></r><rPh><t>XX</t></rPh></si><si><t>R. A &amp; B_x000D_</t></si></sst>';
    const sheet = `<x:worksheet><x:sheetData>
      <x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>0</x:v></x:c></x:row>
      <x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>Rua X, 10</x:t></x:is></x:c><x:c r="C2"><x:v>1234567</x:v></x:c></x:row>
      <x:row r="4"><x:c r="A4" t="s"><x:v>2</x:v></x:c><x:c r="B4" t="b"><x:v>1</x:v></x:c><x:c r="C4"><x:v>2.5000000000000004</x:v></x:c></x:row>
    </x:sheetData></x:worksheet>`;
    const { sheets } = readSpreadsheetBytes(makeXlsx(sheet, { shared, prefix: 'x' }));
    expect(sheets[0].name).toBe('Dados & CEP');
    expect(sheets[0].rows).toEqual([
      ['Endereço', '', 'CEP'],
      ['Rua X, 10', '', '1234567'],
      [],
      ['R. A & B', 'VERDADEIRO', '2.5'],
    ]);
  });

  it('não trava nem estoura com XML malformado (tag sem fechar)', () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rua A, 1</t></is></c></row>${'<row><c><v>1'.repeat(20000)}</sheetData></worksheet>`;
    const t0 = Date.now();
    const { sheets } = readSpreadsheetBytes(makeXlsx(sheet));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sheets[0].rows[0]).toEqual(['Rua A, 1']);
  });

  it('ignora colunas além do limite e não resolve entidades externas', () => {
    const sheet = '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c><c r="ZZZ1" t="inlineStr"><is><t>longe</t></is></c></row></sheetData></worksheet>';
    const { sheets } = readSpreadsheetBytes(makeXlsx(sheet));
    expect(sheets[0].rows).toEqual([['&e;']]);
  });

  it('recusa .xls antigo/protegido e zip que não é planilha com mensagem clara', () => {
    expect(() => readSpreadsheetBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).toThrow(SpreadsheetError);
    expect(() => readSpreadsheetBytes(zipSync({ 'a.txt': strToU8('oi') }))).toThrow(/não reconhecido/);
    expect(() => readSpreadsheetBytes(new Uint8Array([0x50, 0x4b, 1, 2, 3]))).toThrow(SpreadsheetError);
  });
});

describe('CSV/TSV', () => {
  it('detecta ponto e vírgula (Excel em português) e respeita aspas', () => {
    const csv = '﻿Endereço;Bairro;Cidade;CEP\r\n"Rua A, 10";Centro;"São ""Paulo""";01001000\r\n"Rua B, 20\nfundos";Sé;São Paulo;01001-001\r\n';
    expect(parseDelimited(csv)).toEqual([
      ['Endereço', 'Bairro', 'Cidade', 'CEP'],
      ['Rua A, 10', 'Centro', 'São "Paulo"', '01001000'],
      ['Rua B, 20\nfundos', 'Sé', 'São Paulo', '01001-001'],
    ]);
  });

  it('detecta vírgula e TAB', () => {
    expect(parseDelimited('a,b\n1,"2,3"\n')).toEqual([['a', 'b'], ['1', '2,3']]);
    expect(parseDelimited('a\tb, c\n1\t2, 3')).toEqual([['a', 'b, c'], ['1', '2, 3']]);
  });

  it('decodifica UTF-8 e cai para Windows-1252', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x53, 0xc3, 0xa9]))).toBe('Sé');
    expect(decodeText(new Uint8Array([0x53, 0xe9, 0x3b, 0x53, 0xe3, 0x6f]))).toBe('Sé;São');
  });

  it('reconhece texto colado do Google Planilhas (TAB)', () => {
    expect(looksTabular('Endereço\tCidade\nRua A, 1\tSP\nRua B, 2\tSP')).toBe(true);
    expect(looksTabular('Rua A, 1 - Centro\nSão Paulo - SP')).toBe(false);
  });
});

describe('detecção de colunas', () => {
  it('aceita títulos cortados e variações', () => {
    expect(headerScore('Destination A', 'address')).toBeGreaterThanOrEqual(80);
    expect(headerScore('ZipCode', 'zip')).toBe(100);
    expect(headerScore('Nº', 'number')).toBe(100);
    expect(headerScore('Número do pedido', 'number')).toBe(0);
    expect(headerScore('Número do pedido', 'order')).toBe(100);
    expect(headerScore('Cidade do remetente', 'city')).toBe(0);
  });

  it('modelo em português com número separado e UF', () => {
    const rows = [
      ['Nome do cliente', 'Logradouro', 'Nº', 'Complemento', 'Bairro', 'Município', 'UF', 'CEP', 'Número do pedido', 'Obs'],
      ['José', 'R. Sete de Setembro', '45', 'Casa 2', 'Centro', 'Curitiba', 'pr', '80060-070', '9981', 'Portão azul'],
      ['Ana', 'Rua Sete de Setembro, 50', '50', '', 'Centro', 'Curitiba', 'PR', '80060070', '', ''],
    ];
    const { det, items } = importRows(rows);
    expect(det.mapping).toMatchObject({ customer: 0, address: 1, number: 2, complement: 3, neighborhood: 4, city: 5, state: 6, zip: 7, order: 8, notes: 9 });
    expect(items).toEqual([
      { address: 'Rua Sete de Setembro, 45 - Centro, Curitiba - PR, 80060-070', ref: 'José · Pedido 9981 · Compl.: Casa 2 · Obs.: Portão azul' },
      { address: 'Rua Sete de Setembro, 50 - Centro, Curitiba - PR, 80060-070', ref: 'Ana' },
    ]);
  });

  it('coluna com endereço completo não duplica bairro/cidade/CEP', () => {
    const rows = [['Endereço completo', 'Cidade', 'CEP'], ['Av. Brasil, 100 - Centro, Rio de Janeiro - RJ 20040-002', 'Rio de Janeiro', '20040002']];
    expect(importRows(rows).items[0].address).toBe('Avenida Brasil, 100 - Centro, Rio de Janeiro - RJ 20040-002');
  });

  it('sem cabeçalho: descobre pelo conteúdo', () => {
    const rows = [
      ['1', 'Rua A, 10', 'Centro', '1001000', 'SP'],
      ['2', 'Av. B, 20', 'Sé', '01001-001', 'SP'],
    ];
    const { det, items } = importRows(rows);
    expect(det.headerRow).toBe(-1);
    expect(det.mapping).toMatchObject({ address: 1, zip: 3, state: 4 });
    expect(items.map((i) => i.address)).toEqual(['Rua A, 10 - SP, 01001-000', 'Avenida B, 20 - SP, 01001-001']);
  });

  it('títulos desconhecidos: usa o conteúdo e trata a 1ª linha como título', () => {
    const rows = [['Cod', 'Local', 'Info A'], ['X1', 'Rua Harmonia 50', 'Vila Madalena'], ['X2', 'Rua Fradique Coutinho 200', 'Pinheiros']];
    const { det, items } = importRows(rows);
    expect(det.headerRow).toBe(0);
    expect(det.headers).toEqual(rows[0]);
    expect(items.map((i) => i.address)).toEqual(['Rua Harmonia 50', 'Rua Fradique Coutinho 200']);
  });

  it('sem coluna de endereço: lê a linha inteira como texto', () => {
    const rows = [['Entrega Rua das Flores 12 Centro', 'x'], ['nada aqui', 'y']];
    const { items, skipped } = importRows(rows);
    expect(items.map((i) => i.address)).toEqual(['Rua das Flores 12 Centro, x']);
    expect(skipped).toBe(1);
  });

  it('CEP e nomes de coluna', () => {
    expect(formatCep('1310100')).toBe('01310-100');
    expect(formatCep('01.310-100')).toBe('01310-100');
    expect(formatCep('ABC')).toBeNull();
    expect(buildAddress(['Rua A', '', ''], { address: 0, number: 1 })).toBe('Rua A');
    expect(columnName(['Rua'], 0)).toBe('A · Rua');
    expect(columnName([], 27)).toBe('Coluna AB');
  });
});
