import { describe, expect, it } from 'vitest';
import { limitarResultado, requisicaoPermitida } from './sistemas';

/** A trava de leitura da v1. Se algum destes falhar, o Gerente poderia escrever num sistema. */
describe('trava de leitura (v1)', () => {
  it('GET em /api/ e /health passa nos tres sistemas', () => {
    for (const s of ['analytics', 'actions', 'nf'] as const) {
      expect(requisicaoPermitida(s, 'GET', '/api/qualquer?x=1')).toBe(true);
      expect(requisicaoPermitida(s, 'GET', '/health')).toBe(true);
    }
  });

  it('bloqueia TODAS as rotas de escrita conhecidas do ml-actions e do tiny-pedidos-nf', () => {
    const escritas: Array<['actions' | 'nf', string]> = [
      ['actions', '/api/listings/recreate/execute'],
      ['actions', '/api/listings/recreate/probe'],
      ['actions', '/api/listings/recreate/discard'],
      ['actions', '/api/listings/MLB1/recreate/simulate'],
      ['nf', '/api/orders/123/process'],
      ['nf', '/api/orders/process-batch'],
      ['nf', '/api/scheduler'],
      ['nf', '/api/processed/clear'],
      ['nf', '/api/price-lists/refresh'],
      ['nf', '/api/dispatch-cache/clear'],
    ];
    for (const [s, rota] of escritas) expect(requisicaoPermitida(s, 'POST', rota)).toBe(false);
  });

  it('POST so na rota de ferramentas do analytics', () => {
    expect(requisicaoPermitida('analytics', 'POST', '/api/assistente/ferramenta/consultar_sql')).toBe(true);
    expect(requisicaoPermitida('analytics', 'POST', '/api/catalog/refresh')).toBe(false);
    expect(requisicaoPermitida('nf', 'POST', '/api/assistente/ferramenta/consultar_sql')).toBe(false);
  });

  it('PUT, PATCH e DELETE nunca passam', () => {
    for (const m of ['PUT', 'PATCH', 'DELETE']) expect(requisicaoPermitida('analytics', m, '/api/x')).toBe(false);
  });

  it('rotas fora de /api/ (oauth, debug) e caminho com .. sao recusados', () => {
    expect(requisicaoPermitida('nf', 'GET', '/oauth/login')).toBe(false);
    expect(requisicaoPermitida('nf', 'GET', '/api/debug/../../oauth/login')).toBe(false);
    expect(requisicaoPermitida('nf', 'GET', '/api//x')).toBe(false);
  });
});

describe('limitarResultado', () => {
  it('devolve igual quando cabe', () => {
    expect(limitarResultado({ a: 1 }, 100)).toEqual({ a: 1 });
  });
  it('corta com aviso quando nao cabe', () => {
    const r: any = limitarResultado({ lista: 'x'.repeat(500) }, 100);
    expect(r.aviso).toContain('incompleta');
    expect(r.parcial).toHaveLength(100);
  });
});
