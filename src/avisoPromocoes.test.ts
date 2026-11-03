import { describe, expect, it } from 'vitest';
import { deveAvisar, horaEmBrasilia } from './avisoPromocoes';

describe('aviso diario de promocoes', () => {
  it('converte pro horario de Brasilia', () => {
    expect(horaEmBrasilia(new Date('2026-11-03T12:30:00Z'))).toEqual({ hora: 9, dia: '2026-11-03' });
    // 01:00 UTC ainda e o dia anterior em Brasilia
    expect(horaEmBrasilia(new Date('2026-11-04T01:00:00Z'))).toEqual({ hora: 22, dia: '2026-11-03' });
  });

  it('so na hora marcada e uma vez por dia', () => {
    const nove = new Date('2026-11-03T12:10:00Z');
    expect(deveAvisar(nove, 9, null)).toBe(true);
    expect(deveAvisar(nove, 9, '2026-11-03')).toBe(false);
    expect(deveAvisar(new Date('2026-11-03T13:10:00Z'), 9, null)).toBe(false);
    expect(deveAvisar(new Date('2026-11-04T12:10:00Z'), 9, '2026-11-03')).toBe(true);
  });
});
