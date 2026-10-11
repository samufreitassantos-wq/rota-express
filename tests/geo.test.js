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
  it('gera links do Google Maps e Waze', () => {
    const p = { lat: -23.55, lng: -46.63 };
    expect(googleMapsUrl(p)).toBe('https://www.google.com/maps/dir/?api=1&destination=-23.55,-46.63&travelmode=driving');
    expect(wazeUrl(p)).toBe('https://waze.com/ul?ll=-23.55,-46.63&navigate=yes');
    expect(wazeUrl({ lat: -23.5, lng: -46.63999999999999 })).toBe('https://waze.com/ul?ll=-23.5,-46.64&navigate=yes');
  });
});
