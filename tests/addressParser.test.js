import { describe, it, expect } from 'vitest';
import { extractAddresses, normalizeAddress, extractCep } from '../src/lib/addressParser.js';

describe('normalizeAddress', () => {
  it('expande abreviações e formata CEP', () => {
    expect(normalizeAddress('  R. das Flores ,  nº 123 ,Centro , 01310100 '))
      .toBe('Rua das Flores, 123, Centro, 01310-100');
    expect(normalizeAddress('Av Paulista, 1000')).toBe('Avenida Paulista, 1000');
  });
  it('não altera palavras que não são logradouro', () => {
    expect(normalizeAddress('Rodrigo Silva 10')).toBe('Rodrigo Silva 10');
  });
});

describe('extractCep', () => {
  it('encontra CEP com ou sem hífen', () => {
    expect(extractCep('cep 04567890')).toBe('04567-890');
    expect(extractCep('sem cep')).toBeNull();
  });
});

describe('extractAddresses', () => {
  it('extrai endereços de linhas de texto e junta linhas de complemento', () => {
    const text = [
      'Pedido 001 - Cliente: Maria',
      'R. das Flores, 123 - Centro',
      'São Paulo - SP 01310-100',
      'Pedido 002 - Cliente: João',
      'Entrega: Av. Brasil, nº 45, Jardim América',
      'Pedido 003',
      'Travessa Sete 7',
      'Observação: portão azul',
    ].join('\n');
    expect(extractAddresses(text).map((a) => a.address)).toEqual([
      'Rua das Flores, 123 - Centro, São Paulo - SP 01310-100',
      'Avenida Brasil, 45, Jardim América',
      'Travessa Sete 7',
    ]);
  });
  it('remove duplicados e ignora linhas sem número', () => {
    const text = 'Rua A, 10\nrua a, 10\nRua sem número';
    expect(extractAddresses(text)).toEqual([{ address: 'Rua A, 10', cep: null }]);
  });
});
