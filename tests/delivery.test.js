import { describe, it, expect } from 'vitest';
import { migrateStop, routeStats, moveTo, moveBy, toCsv, routeFileName } from '../src/lib/delivery.js';
import { googleMapsMultiUrl } from '../src/lib/navLinks.js';

describe('migrateStop', () => {
  it('converte o formato antigo', () => {
    expect(migrateStop({ id: 'a', delivered: true, deliveredAt: 'T' })).toEqual({ id: 'a', outcome: 'delivered', outcomeAt: 'T' });
    expect(migrateStop({ id: 'b', delivered: false })).toEqual({ id: 'b', outcome: null, outcomeAt: undefined });
  });
  it('não altera paradas já migradas', () => {
    expect(migrateStop({ id: 'c', outcome: 'failed', outcomeAt: 'T' })).toEqual({ id: 'c', outcome: 'failed', outcomeAt: 'T' });
  });
});

describe('routeStats', () => {
  it('conta entregues, problemas e pendentes', () => {
    expect(routeStats([{ outcome: 'delivered' }, { outcome: 'failed' }, { outcome: null }, {}]))
      .toEqual({ total: 4, delivered: 1, failed: 1, pending: 2 });
  });
});

describe('reordenação', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('move para uma posição', () => {
    expect(moveTo(order, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTo(order, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('sobe/desce e respeita os limites', () => {
    expect(moveBy(order, 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveBy(order, 'a', -1)).toEqual(order);
    expect(moveBy(order, 'd', 1)).toEqual(order);
  });
  it('não altera a lista original', () => {
    moveTo(order, 'b', 3);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('toCsv', () => {
  it('gera CSV com ; e escapa campos', () => {
    const csv = toCsv({ createdAt: '2026-10-11T10:00:00Z' }, [
      { address: 'Rua A, 1', outcome: 'delivered', note: 'Portão "azul"; fundos', lat: -23.5, lng: -46.6, hasPhoto: true, outcomeDistM: 12 },
      { address: 'Rua B, 2', ref: 'Ana · Pedido 7', outcome: 'failed', failReason: 'Cliente ausente' },
      { address: 'Rua C, 3', outcome: null },
    ]);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('Ordem;Endereço;Referência;Situação;Motivo;Observação;Chegada (GPS);Horário;Distância do ponto (m);Foto;Latitude;Longitude');
    expect(lines[1]).toBe('1;Rua A, 1;;Entregue;;"Portão ""azul""; fundos";;;12;sim;-23.500000;-46.600000');
    expect(lines[2]).toBe('2;Rua B, 2;Ana · Pedido 7;Problema;Cliente ausente;;;;;;;');
    expect(lines[3]).toBe('3;Rua C, 3;;Pendente;;;;;;;;');
  });
  it('neutraliza fórmulas (CSV injection) sem alterar números negativos', () => {
    const csv = toCsv({ createdAt: '2026-10-11T10:00:00Z' }, [
      { address: '=HYPERLINK("http://mal.example","Clique")', outcome: 'failed', failReason: '@SUM(1)', note: '+cmd', lat: -23.5, lng: -46.6 },
    ]);
    const line = csv.replace('\uFEFF', '').trim().split('\r\n')[1];
    expect(line).toContain(`"'=HYPERLINK(""http://mal.example"",""Clique"")"`);
    expect(line).toContain("'@SUM(1)");
    expect(line).toContain("'+cmd");
    expect(line).toContain(';-23.500000;-46.600000');
  });

  it('nomeia o arquivo pela data', () => {
    expect(routeFileName({ createdAt: '2026-10-11T10:05:00' }, 'csv')).toBe('rota-2026-10-11-1005.csv');
    expect(routeFileName({ createdAt: '2026-10-11T10:05:00', finishedAt: '2026-10-11T18:30:00' }, 'pdf')).toBe('rota-2026-10-11-1830.pdf');
  });
});

describe('googleMapsMultiUrl', () => {
  const stops = [1, 2, 3, 4, 5].map((i) => ({ address: `Rua ${i}, ${i * 10}`, lat: -23 - i / 10, lng: -46 }));
  it('usa até 3 paradas intermediárias e a 4ª como destino, pelos endereços', () => {
    expect(googleMapsMultiUrl(stops, (s) => `${s.address}, São Paulo`)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent('Rua 4, 40, São Paulo') +
        '&waypoints=' + encodeURIComponent('Rua 1, 10, São Paulo|Rua 2, 20, São Paulo|Rua 3, 30, São Paulo') + '&travelmode=driving',
    );
  });
  it('parada com pino ajustado vai por coordenada; sem paradas retorna null', () => {
    const url = googleMapsMultiUrl([{ ...stops[0], pinAdjusted: true }]);
    expect(url).toBe('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent('-23.1,-46') + '&travelmode=driving');
    expect(googleMapsMultiUrl([])).toBeNull();
  });
});
