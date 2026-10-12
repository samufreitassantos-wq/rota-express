import { describe, it, expect } from 'vitest';
import { haversine, distanceMatrix, optimizeOrder, pathCost } from '../src/lib/geo.js';
import { googleMapsUrl, wazeUrl } from '../src/lib/navLinks.js';

describe('haversine', () => {
  it('calcula ~111 km por grau de latitude', () => {
    expect(haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) / 1000).toBeCloseTo(111.19, 1);
  });
});

describe('optimizeOrder', () => {
  it('visita pontos em linha na ordem natural', () => {
    const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.03 }, { lat: 0, lng: 0.01 }, { lat: 0, lng: 0.02 }];
    expect(optimizeOrder(distanceMatrix(pts))).toEqual([2, 3, 1]);
  });

  it('retorna permutação válida e melhora a ordem original com 60 paradas', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pts = Array.from({ length: 61 }, () => ({ lat: -23.5 + rnd() * 0.2, lng: -46.6 + rnd() * 0.2 }));
    const m = distanceMatrix(pts);
    const order = optimizeOrder(m);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    const naive = Array.from({ length: 60 }, (_, i) => i + 1);
    expect(pathCost(m, order)).toBeLessThan(pathCost(m, naive) * 0.5);
  });

  it('lida com zero paradas', () => {
    expect(optimizeOrder([[0]])).toEqual([]);
  });
});

describe('navLinks', () => {
  const stop = { address: 'Rua Augusta, 1200 - Consolação', lat: -23.55, lng: -46.63 };
  it('usa o endereço escrito (numeração do Google), não as coordenadas', () => {
    expect(googleMapsUrl(stop, 'Rua Augusta, 1200 - Consolação, São Paulo - SP')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent('Rua Augusta, 1200 - Consolação, São Paulo - SP') + '&travelmode=driving');
    expect(wazeUrl(stop, 'Rua Augusta, 1200, São Paulo')).toBe('https://waze.com/ul?q=' + encodeURIComponent('Rua Augusta, 1200, São Paulo') + '&navigate=yes');
  });
  it('pino ajustado à mão: usa as coordenadas confirmadas', () => {
    const p = { ...stop, pinAdjusted: true, lng: -46.63999999999999 };
    expect(googleMapsUrl(p, 'qualquer')).toBe('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent('-23.55,-46.64') + '&travelmode=driving');
    expect(wazeUrl(p)).toBe('https://waze.com/ul?ll=-23.55,-46.64&navigate=yes');
  });
  it('sem endereço, cai para as coordenadas; remove "|" que quebraria as paradas', () => {
    expect(wazeUrl({ address: '', lat: -23.5, lng: -46.6 })).toBe('https://waze.com/ul?ll=-23.5,-46.6&navigate=yes');
    expect(googleMapsUrl({ address: 'Rua A | B, 1' })).toContain(encodeURIComponent('Rua A B, 1'));
  });
});
