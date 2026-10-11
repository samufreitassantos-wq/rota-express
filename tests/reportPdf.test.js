import { describe, it, expect } from 'vitest';
import { buildReportPdf, reportRows } from '../src/lib/reportPdf.js';

const stops = [
  { id: 'a', address: 'Rua A, 1', outcome: 'delivered', outcomeAt: '2026-10-11T13:00:00Z', note: 'Porteiro' },
  { id: 'b', address: 'Rua B, 2', outcome: 'failed', failReason: 'Cliente ausente', outcomeAt: '2026-10-11T13:10:00Z' },
  { id: 'c', address: 'Rua C, 3', outcome: null },
];

describe('reportRows', () => {
  it('monta as colunas do relatório', () => {
    const rows = reportRows(stops);
    expect(rows[0].slice(0, 3)).toEqual(['1', 'Rua A, 1', 'Entregue']);
    expect(rows[0][4]).toBe('Porteiro');
    expect(rows[1][2]).toBe('Problema\nCliente ausente');
    expect(rows[2][2]).toBe('Pendente');
    expect(rows[2][3]).toBe('');
  });
});

describe('buildReportPdf', () => {
  it('gera um PDF válido com os endereços', async () => {
    const blob = buildReportPdf({ name: 'Rota teste', createdAt: '2026-10-11T12:00:00Z', plan: { distance: 12345 } }, stops);
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    expect(blob.type).toBe('application/pdf');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('Rua B, 2');
    expect(text).toContain('(ausente) Tj');
    expect(text).toContain('(Situação) Tj');
  });
});
