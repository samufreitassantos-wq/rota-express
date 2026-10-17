import { describe, it, expect } from 'vitest';
import { streetInfo, groupByStreet, orderWithinStreet, expandGroups, streetRuns, groupWindow } from '../src/lib/streets.js';
import { planStreetRoute } from '../src/lib/planner.js';

const st = (id, address, lat, lng, extra = {}) => ({ id, address, lat, lng, ...extra });

describe('ruas', () => {
  it('reconhece rua e número, ignorando bairro/CEP e diferenças de acento/maiúsculas', () => {
    expect(streetInfo('Rua Ipatinga, 10 - Centro, São Paulo, 01000-000')).toMatchObject({ street: 'Rua Ipatinga', number: '10', numberValue: 10 });
    expect(streetInfo('RUA IPATINGA 5').key).toBe(streetInfo('Rua Ipatinga, 99').key);
    expect(streetInfo('Rua Itaquera, 1').key).not.toBe(streetInfo('Rua Ipatinga, 1').key);
    expect(streetInfo('Rua 25 de Março, 100').street).toBe('Rua 25 de Março');
  });

  it('agrupa a mesma rua e separa o mesmo nome em lugares distantes', () => {
    const g = groupByStreet([
      st('a', 'Rua Ipatinga, 5', -23.5, -46.6),
      st('b', 'Rua Itaquera, 20', -23.51, -46.6),
      st('c', 'Rua Ipatinga, 10', -23.5005, -46.6),
      st('d', 'Rua Itaquera, 1', -23.511, -46.6),
      st('e', 'Rua Ipatinga, 7', -22.9, -43.2), // mesmo nome, outra cidade (sem cidade escrita)
    ]);
    expect(g.map((x) => x.stops.map((s) => s.id))).toEqual([['a', 'c'], ['b', 'd'], ['e']]);
    expect(g[0].street).toBe('Rua Ipatinga');
  });

  it('com e sem cidade escrita é a mesma rua; cidades diferentes não', () => {
    const g = groupByStreet([
      st('a', 'Rua Augusta, 692 - Cerqueira Cesar', -23.55, -46.65),
      st('b', 'Rua Augusta, 396 - Cerqueira Cesar, São Paulo - SP 01414-000', -23.552, -46.65),
      st('c', 'Rua Augusta, 10 - Centro, Campinas - SP', -23.553, -46.65),
    ]);
    expect(g.map((x) => x.stops.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('números em sequência; começa pela ponta mais perto quando as posições são precisas', () => {
    const s = [st('n20', 'Rua X, 20', -23.502, -46.6), st('n1', 'Rua X, 1', -23.5, -46.6), st('sn', 'Rua X', -23.501, -46.6), st('n7', 'Rua X, 7', -23.501, -46.6)];
    expect(orderWithinStreet(s, null).map((x) => x.id)).toEqual(['n1', 'n7', 'n20', 'sn']);
    expect(orderWithinStreet(s, { lat: -23.503, lng: -46.6 }).map((x) => x.id)).toEqual(['n20', 'n7', 'n1', 'sn']);
    // Posição só da rua (aproximada): mantém crescente
    const approx = s.map((x) => ({ ...x, precise: false }));
    expect(orderWithinStreet(approx, { lat: -23.503, lng: -46.6 }).map((x) => x.id)).toEqual(['n1', 'n7', 'n20', 'sn']);
  });

  it('trechos consecutivos da mesma rua para a tela', () => {
    const runs = streetRuns([st('a', 'Rua A, 1'), st('b', 'Rua A, 3'), st('c', 'Rua B, 2'), st('d', 'Rua A, 9')]);
    expect(runs.map((r) => [r.street, r.stops.length])).toEqual([['Rua A', 2], ['Rua B', 1], ['Rua A', 1]]);
  });

  it('janela da rua = a mais apertada', () => {
    expect(groupWindow([null, { start: 600, end: 720 }, { start: 660, end: 900 }])).toEqual({ start: 660, end: 720 });
    expect(groupWindow([{ start: 900, end: 960 }, { start: 600, end: 660 }])).toEqual({ start: 600, end: 660 });
    expect(groupWindow([null])).toBeNull();
  });
});

describe('rota por ruas (sem chave: otimização local)', () => {
  it('visita as ruas em ordem e todos os números de cada rua juntos', async () => {
    // Exemplo do usuário: Ipatinga 5 e 10, Itaquera 20 e 1 — misturados na lista.
    const stops = [
      st('ip10', 'Rua Ipatinga, 10', -23.5000, -46.6000, { precise: false }),
      st('it20', 'Rua Itaquera, 20', -23.5100, -46.6000, { precise: false }),
      st('ip5', 'Rua Ipatinga, 5', -23.5000, -46.6000, { precise: false }),
      st('it1', 'Rua Itaquera, 1', -23.5100, -46.6000, { precise: false }),
      st('fl', 'Rua das Flores, 3', -23.5200, -46.6000),
    ];
    const r = await planStreetRoute({ lat: -23.495, lng: -46.6 }, stops, {});
    expect(r.order.map((i) => stops[i].id)).toEqual(['ip5', 'ip10', 'it1', 'it20', 'fl']);
    expect(r.streets).toBe(3);
    expect(r.method).toBe('local');
    expect(r.distance).toBeGreaterThan(0);
  });

  it('a ordem das ruas segue a proximidade, não a ordem da lista', async () => {
    const stops = [
      st('far', 'Rua Longe, 1', -23.60, -46.6),
      st('near', 'Rua Perto, 1', -23.50, -46.6),
      st('mid', 'Rua Meio, 1', -23.55, -46.6),
    ];
    const r = await planStreetRoute({ lat: -23.49, lng: -46.6 }, stops, {});
    expect(r.order.map((i) => stops[i].id)).toEqual(['near', 'mid', 'far']);
    expect(expandGroups([], null)).toEqual([]);
  });
});

describe('reordenar ruas', async () => {
  const { moveStreet, reverseStreet } = await import('../src/lib/streets.js');
  it('move a rua inteira e inverte os números', () => {
    const runs = [['a1', 'a2'], ['b1'], ['c1', 'c2']];
    expect(moveStreet(runs, 2, 0)).toEqual(['c1', 'c2', 'a1', 'a2', 'b1']);
    expect(moveStreet(runs, 0, 1)).toEqual(['b1', 'a1', 'a2', 'c1', 'c2']);
    expect(reverseStreet(runs, 0)).toEqual(['a2', 'a1', 'b1', 'c1', 'c2']);
  });
});
