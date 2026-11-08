import { beforeEach, describe, expect, it } from 'vitest';

process.env.MEMORIA_TROCAS = '3';
process.env.MEMORIA_MINUTOS = '60';

const { lembrar, guardar, esquecer, comoMensagens, resumoDaMemoria } = await import('./memoria');

describe('memoria curta por conversa', () => {
  beforeEach(() => {
    esquecer('a');
    esquecer('b');
  });

  it('lembra as trocas na ordem, so da conversa certa', () => {
    guardar('a', 'quanto vendemos?', 'R$ 100');
    guardar('b', 'outra coisa', 'x');
    guardar('a', 'e ontem?', 'R$ 80');
    expect(lembrar('a').map((t) => t.pergunta)).toEqual(['quanto vendemos?', 'e ontem?']);
    expect(comoMensagens(lembrar('a'))).toEqual([
      { role: 'user', content: 'quanto vendemos?' },
      { role: 'assistant', content: 'R$ 100' },
      { role: 'user', content: 'e ontem?' },
      { role: 'assistant', content: 'R$ 80' },
    ]);
  });

  it('guarda so as ultimas N trocas', () => {
    for (let i = 1; i <= 5; i++) guardar('a', `p${i}`, `r${i}`);
    expect(lembrar('a').map((t) => t.pergunta)).toEqual(['p3', 'p4', 'p5']);
  });

  it('esquece depois do prazo', () => {
    const t0 = 1_000_000_000_000;
    guardar('a', 'velha', 'x', t0);
    guardar('a', 'nova', 'y', t0 + 50 * 60 * 1000);
    expect(lembrar('a', t0 + 70 * 60 * 1000).map((t) => t.pergunta)).toEqual(['nova']);
    expect(resumoDaMemoria(t0 + 70 * 60 * 1000)).toEqual({ a: 1 });
    expect(lembrar('a', t0 + 200 * 60 * 1000)).toEqual([]);
  });

  it('sem chave de conversa nao guarda nada', () => {
    guardar('', 'p', 'r');
    expect(lembrar('')).toEqual([]);
  });

  it('/esquecer limpa a conversa', () => {
    guardar('a', 'p', 'r');
    esquecer('a');
    expect(lembrar('a')).toEqual([]);
  });
});
