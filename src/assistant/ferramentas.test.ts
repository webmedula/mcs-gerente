import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Testes com fetch simulado: nenhum sistema real e chamado. As variaveis sao definidas ANTES de
 * importar os modulos, porque o config le o ambiente na importacao.
 */
process.env.ANALYTICS_BASE_URL = 'http://analytics.test';
process.env.ACTIONS_BASE_URL = 'http://actions.test';
process.env.NF_BASE_URL = 'http://nf.test';
process.env.NF_API_KEY = 'chave-nf';
process.env.OCORRENCIAS_BASE_URL = 'http://oc.test';
process.env.OCORRENCIAS_API_KEY = 'mcsia_teste';

const { FERRAMENTAS_LOCAIS, catalogo, executarFerramenta, _limparCacheAnalytics } = await import('./ferramentas');

type Resposta = { status?: number; corpo: unknown };
let rotas: Record<string, Resposta | ((init: any) => Resposta)> = {};
const chamadas: Array<{ url: string; init: any }> = [];

beforeEach(() => {
  rotas = {};
  chamadas.length = 0;
  _limparCacheAnalytics();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    chamadas.push({ url, init });
    const r = rotas[`${init?.method ?? 'GET'} ${url}`];
    if (!r) throw new Error(`conexao recusada (${url})`);
    const res = typeof r === 'function' ? r(init) : r;
    return new Response(JSON.stringify(res.corpo), { status: res.status ?? 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('definicoes locais', () => {
  it('nomes unicos e validos, descricao util, schema de objeto, required existente', () => {
    const nomes = FERRAMENTAS_LOCAIS.map((f) => f.definicao.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const { definicao: f } of FERRAMENTAS_LOCAIS) {
      expect(f.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(f.description.length).toBeGreaterThan(40);
      const schema = f.input_schema as any;
      expect(schema.type).toBe('object');
      for (const req of schema.required ?? []) expect(Object.keys(schema.properties ?? {})).toContain(req);
    }
  });
});

describe('ferramentas do ml-analytics (buscadas em tempo de execucao)', () => {
  it('junta as do analytics com as locais', async () => {
    rotas['GET http://analytics.test/api/assistente/ferramentas'] = {
      corpo: { ferramentas: [{ name: 'resumo_da_operacao', description: 'x', input_schema: { type: 'object' } }] },
    };
    const cat = await catalogo();
    expect(cat.ferramentas.map((f) => f.name)).toContain('resumo_da_operacao');
    expect(cat.ferramentas.map((f) => f.name)).toContain('nf_pedidos_pendentes');
    expect(cat.avisos).toHaveLength(0);
  });

  it('analytics fora do ar: segue com as locais e avisa o modelo', async () => {
    const cat = await catalogo();
    expect(cat.ferramentas.length).toBe(FERRAMENTAS_LOCAIS.length);
    expect(cat.avisos[0]).toContain('ml-analytics');
  });

  it('executa por POST na rota de ferramentas, repassando a entrada', async () => {
    rotas['GET http://analytics.test/api/assistente/ferramentas'] = {
      corpo: { ferramentas: [{ name: 'consultar_sql', description: 'x', input_schema: { type: 'object' } }] },
    };
    rotas['POST http://analytics.test/api/assistente/ferramenta/consultar_sql'] = (init) => ({
      corpo: { saida: { recebido: JSON.parse(init.body).entrada } },
    });
    const r: any = await executarFerramenta('consultar_sql', { sql: 'SELECT 1' });
    expect(r).toEqual({ recebido: { sql: 'SELECT 1' } });
  });

  it('nome desconhecido volta como dado', async () => {
    await expect(executarFerramenta('nao_existe', {})).resolves.toMatchObject({ erro: expect.stringContaining('nao_existe') });
  });
});

describe('ferramentas do tiny-pedidos-nf', () => {
  const pendentes = {
    atualizadoEm: '2026-09-24T10:00:00Z',
    orders: [
      { id: 901, numeroPedido: 5001, numeroPedidoEcommerce: 'SHP-1', marketplace: 'Shopee', cliente: 'A', valor: '10', prontoParaNf: true, jaProcessado: false },
      { id: 902, numeroPedido: 5002, marketplace: 'Mercado Livre', cliente: 'B', valor: '20', prontoParaNf: false, jaProcessado: false, bloqueado: true, motivoBloqueio: 'nome oculto' },
    ],
  };

  it('pendentes: resume e envia a chave do sistema', async () => {
    rotas['GET http://nf.test/api/orders/pending'] = { corpo: pendentes };
    const r: any = await executarFerramenta('nf_pedidos_pendentes', { filtro: 'bloqueados' });
    expect(r.total).toBe(2);
    expect(r.prontosParaNf).toBe(1);
    expect(r.porCanal).toEqual({ Shopee: 1, 'Mercado Livre': 1 });
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].motivoBloqueio).toBe('nome oculto');
    expect(chamadas[0].init.headers['x-api-key']).toBe('chave-nf');
  });

  it('previa: traduz numero do pedido para o id interno', async () => {
    rotas['GET http://nf.test/api/orders/pending'] = { corpo: pendentes };
    rotas['GET http://nf.test/api/orders/901/preview'] = { corpo: { orderId: 901, valorTotalComDesconto: 9 } };
    const r: any = await executarFerramenta('nf_previa_pedido', { pedido: '5001' });
    expect(r.orderId).toBe(901);
  });

  it('vendas do dia exige data valida (nao deixa cair no "hoje" UTC do servidor)', async () => {
    const r: any = await executarFerramenta('nf_vendas_do_dia', { data: 'ontem' });
    expect(r.erro).toBeTruthy();
    expect(chamadas).toHaveLength(0);
  });

  it('erro HTTP do sistema chega como mensagem util', async () => {
    rotas['GET http://nf.test/api/processed'] = { status: 401, corpo: { mensagem: 'x-api-key invalida' } };
    await expect(executarFerramenta('nf_processados', {})).rejects.toThrow(/recusou a chave/);
  });
});

describe('ferramentas do ml-actions', () => {
  it('historico nao manda o snapshot (enorme) pro modelo', async () => {
    rotas['GET http://actions.test/api/listings/recreations'] = {
      corpo: { escritaHabilitada: false, items: [{ itemAntigo: 'MLB1', status: 'sucesso', executadoEm: '2026-09-01', snapshot: { grande: true } }] },
    };
    const r: any = await executarFerramenta('recriacao_historico', {});
    expect(r.itens[0].snapshot).toBeUndefined();
    expect(r.totalPorStatus).toEqual({ sucesso: 1 });
  });

  it('formas valida o MLB antes de montar a URL', async () => {
    const r: any = await executarFerramenta('recriacao_formas', { itemId: '../oauth' });
    expect(r.erro).toBeTruthy();
    expect(chamadas).toHaveLength(0);
  });
});

describe('ferramentas da Central de Ocorrencias', () => {
  it('lista: manda a chave como Bearer, traduz rotulos e repassa filtros', async () => {
    rotas['GET http://oc.test/api/admin/ocorrencias?status=nova&responsavel=nenhum&q=5001'] = {
      corpo: {
        itens: [{ protocolo: 'MCS-20261101-AB12', canal: 'shopee', tipo: 'defeito', status: 'nova', nome: 'Ana', email: 'ana@x.com', pedido: '5001', criado_em: '2026-11-01' }],
        total: 1,
        contagem: { nova: 3, em_analise: 2, aguardando_cliente: 1, resolvida: 40 },
        pendencias: 0,
        canais: { shopee: 'Shopee' },
        tipos: { defeito: 'Produto com defeito ou danificado' },
        status: { nova: 'Recebida' },
      },
    };
    const r: any = await executarFerramenta('ocorrencias_lista', { status: 'nova', semResponsavel: true, busca: '5001' });
    expect(chamadas[0].init.headers.authorization).toBe('Bearer mcsia_teste');
    expect(chamadas[0].init.headers['x-api-key']).toBeUndefined();
    expect(r.abertasNoTotal).toBe(6);
    expect(r.itens[0]).toMatchObject({ canal: 'Shopee', assunto: 'Produto com defeito ou danificado', status: 'Recebida' });
    expect(JSON.stringify(r)).not.toContain('ana@x.com');
  });

  it('detalhe valida o protocolo antes de montar a URL', async () => {
    const r: any = await executarFerramenta('ocorrencias_detalhe', { protocolo: '../backups/x' });
    expect(r.erro).toBeTruthy();
    expect(chamadas).toHaveLength(0);
  });

  it('detalhe resume historico e nao repassa e-mail, telefone nem dados crus do Tiny', async () => {
    const eventos = Array.from({ length: 15 }, (_, i) => ({ texto: `evento ${i}`, publico: 1, autor: 'Equipe', criado_em: `2026-11-0${(i % 9) + 1}` }));
    rotas['GET http://oc.test/api/admin/ocorrencias/MCS-1'] = {
      corpo: { protocolo: 'MCS-1', status: 'em_analise', nome: 'Ana', email: 'ana@x.com', telefone: '11999', tiny: { enorme: true }, eventos, ml: null, produtos: [{ titulo: 'Copo' }] },
    };
    const r: any = await executarFerramenta('ocorrencias_detalhe', { protocolo: 'mcs-1' });
    expect(r.historico).toHaveLength(10);
    expect(r.historicoTotal).toBe(15);
    expect(r.produtos).toEqual(['Copo']);
    const json = JSON.stringify(r);
    expect(json).not.toContain('ana@x.com');
    expect(json).not.toContain('11999');
    expect(json).not.toContain('enorme');
  });

  it('403 da Central vira mensagem clara', async () => {
    rotas['GET http://oc.test/api/admin/estatisticas?dias=30'] = { status: 403, corpo: { erro: 'Apenas o gerente pode fazer isso.' } };
    await expect(executarFerramenta('ocorrencias_numeros', {})).rejects.toThrow(/chave da IA nao tem acesso/);
  });

  it('numeros: troca as chaves pelos rotulos e tira os dicionarios', async () => {
    rotas['GET http://oc.test/api/admin/estatisticas?dias=7'] = {
      corpo: { dias: 7, total: 2, porCanal: [{ k: 'shopee', n: 2 }], porTipo: [], porDesfecho: [], canais: { shopee: 'Shopee' }, tipos: {}, desfechos: {} },
    };
    const r: any = await executarFerramenta('ocorrencias_numeros', { dias: 7 });
    expect(r.porCanal).toEqual([{ k: 'Shopee', n: 2 }]);
    expect(r.canais).toBeUndefined();
  });
});
