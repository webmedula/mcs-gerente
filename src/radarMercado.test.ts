import { describe, expect, it } from 'vitest';
import { deveMandarRadar, diaDaSemanaEmBrasilia } from './radarMercado';

describe('radar de mercado', () => {
  it('dia da semana em Brasilia', () => {
    expect(diaDaSemanaEmBrasilia(new Date('2026-11-30T12:00:00Z'))).toBe(1); // segunda
    // 02h UTC de terca ainda e segunda em Brasilia
    expect(diaDaSemanaEmBrasilia(new Date('2026-12-01T02:00:00Z'))).toBe(1);
  });

  it('so segunda 9h, uma vez', () => {
    const seg9 = new Date('2026-11-30T12:10:00Z');
    expect(deveMandarRadar(seg9, 1, 9, null)).toBe(true);
    expect(deveMandarRadar(seg9, 1, 9, '2026-11-30')).toBe(false);
    expect(deveMandarRadar(new Date('2026-12-01T12:10:00Z'), 1, 9, null)).toBe(false); // terca
    expect(deveMandarRadar(new Date('2026-11-30T13:10:00Z'), 1, 9, null)).toBe(false); // 10h
  });
});
