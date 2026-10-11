import { describe, it, expect } from 'vitest';
import { buildBackup, parseBackup, mergeHistory, backupFileName, photoIds } from '../src/lib/backup.js';

const route = (id, finishedAt, stops = []) => ({ id, name: id, createdAt: finishedAt, finishedAt, stops });

describe('buildBackup / parseBackup', () => {
  it('ida e volta preservam rotas, fotos e ajustes, sem a chave ORS', () => {
    const history = [route('h1', '2026-10-10T10:00:00Z', [{ id: 's1', address: 'Rua A, 1', outcome: 'delivered', hasPhoto: true }])];
    const backup = buildBackup({
      settings: { orsKey: 'SEGREDO', defaultCity: 'São Paulo - SP' },
      current: route('c1', null, [{ id: 's2', address: 'Rua B, 2', outcome: null }]),
      history,
      photos: { s1: 'data:image/jpeg;base64,AAAA' },
    }, new Date('2026-10-11T12:00:00Z'));
    const text = JSON.stringify(backup);
    expect(text).not.toContain('SEGREDO');
    const r = parseBackup(text);
    expect(r.exportedAt).toBe('2026-10-11T12:00:00.000Z');
    expect(r.settings).toEqual({ defaultCity: 'São Paulo - SP' });
    expect(r.current.stops[0].address).toBe('Rua B, 2');
    expect(r.history).toHaveLength(1);
    expect(r.photos).toEqual({ s1: 'data:image/jpeg;base64,AAAA' });
  });

  it('migra paradas no formato antigo e descarta dados inválidos', () => {
    const r = parseBackup(JSON.stringify({
      app: 'rota-express', version: 1,
      settings: { orsKey: 'x' },
      history: [route('h1', '2026-01-01T00:00:00Z', [{ id: 's', delivered: true, deliveredAt: 'T' }]), { lixo: true }],
      photos: { a: 'data:image/jpeg;base64,AA', b: 'javascript:alert(1)', c: 42 },
    }));
    expect(r.history).toHaveLength(1);
    expect(r.history[0].stops[0]).toEqual({ id: 's', outcome: 'delivered', outcomeAt: 'T' });
    expect(Object.keys(r.photos)).toEqual(['a']);
    expect(r.settings).toEqual({});
    expect(r.current).toBeNull();
  });

  it('rejeita arquivos que não são backup', () => {
    expect(() => parseBackup('não é json')).toThrow('JSON inválido');
    expect(() => parseBackup('{"app":"outro"}')).toThrow('não é um backup do Rota Express');
    expect(() => parseBackup('{"app":"rota-express","version":99}')).toThrow('versão mais nova');
  });
});

describe('mergeHistory', () => {
  it('junta sem duplicar e ordena do mais recente', () => {
    const local = [route('b', '2026-10-05T00:00:00Z'), route('a', '2026-10-01T00:00:00Z')];
    const incoming = [route('a', '2026-10-01T00:00:00Z'), route('c', '2026-10-09T00:00:00Z'), route('d', '2026-09-01T00:00:00Z')];
    const { history, added } = mergeHistory(local, incoming);
    expect(added).toBe(2);
    expect(history.map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(mergeHistory(local, incoming, 3).history.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('utilitários', () => {
  it('nome do arquivo e ids com foto', () => {
    expect(backupFileName(new Date(2026, 9, 11))).toBe('rota-express-backup-2026-10-11.json');
    const cur = route('c', null, [{ id: 'x', hasPhoto: true }, { id: 'y' }]);
    expect(photoIds(cur, [route('h', 'T', [{ id: 'z', hasPhoto: true }])])).toEqual(['x', 'z']);
    expect(photoIds(null, [])).toEqual([]);
  });
});
