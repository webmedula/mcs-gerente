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
process.env.BACKUP_BASE_URL = 'http://backup.test';
process.env.BACKUP_API_KEY = 'chave-backup';

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

describe('panorama da operacao', () => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dia = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86400000));

  it('junta os sistemas, compara com a semana passada e lista pontos de atencao; sistema fora vira erro no bloco', async () => {
    rotas['GET http://nf.test/api/dashboard?dias=9'] = {
      corpo: {
        hoje: { totalPedidos: 10, vendaReal: 1000, canais: [{ canal: 'Shopee', pedidos: 6, vendaReal: 600 }] },
        serie: [
          { data: dia(-8), pedidos: 20, vendaReal: 2000 },
          { data: dia(-7), pedidos: 12, vendaReal: 1200 },
          { data: dia(-1), pedidos: 14, vendaReal: 1400 },
          { data: hoje, pedidos: 10, vendaReal: 1000 },
        ],
        operacao: { errosHoje: [{ numeroPedido: 1, erro: 'CNPJ invalido', quando: 'x' }] },
      },
    };
    rotas[`GET http://nf.test/api/sales-report?data=${dia(-1)}`] = { corpo: { report: { totalPedidos: 14, vendaReal: 1400, canais: [] } } };
    rotas['GET http://nf.test/api/orders/pending'] = {
      corpo: { orders: [{ numeroPedido: 5, marketplace: 'ML', bloqueado: true, motivoBloqueio: 'nome oculto' }, { numeroPedido: 6, prontoParaNf: true, dataLimiteDespacho: `${hoje}T12:00:00Z` }] },
    };
    rotas['POST http://analytics.test/api/assistente/ferramenta/reposicao_de_estoque'] = {
      corpo: { saida: { itens: [{ itemId: 'MLB1', titulo: 'Copo', urgencia: 'rompido', comprar: 50 }, { itemId: 'MLB2', urgencia: 'ok' }] } },
    };
    rotas['POST http://analytics.test/api/assistente/ferramenta/promocoes_vencendo'] = { corpo: { saida: { disponivel: true, totais: { anunciosVencendo: 2, ficouSemPromocao: 0 }, resumoEmTexto: 'x' } } };
    rotas['GET http://analytics.test/api/questions/pending'] = { corpo: { total: 1, questions: [{ itemId: 'MLB1', text: 'tem azul?', dateCreated: '2026-11-07' }] } };
    rotas['POST http://analytics.test/api/assistente/ferramenta/buy_box'] = { corpo: { saida: { totalNoFiltro: 0, itens: [] } } };
    rotas['GET http://oc.test/api/admin/ocorrencias'] = {
      corpo: { contagem: { nova: 2, em_analise: 1, resolvida: 9 }, itens: [{ protocolo: 'P1', status: 'nova', responsavel: null, tipo: 'defeito' }, { protocolo: 'P2', status: 'nova', responsavel: 'Ana', prazo_em: `${hoje}T10:00:00Z` }], tipos: { defeito: 'Defeito' } },
    };
    // devolucoes sem rota: deve virar erro no bloco, nao derrubar o panorama
    rotas['GET http://analytics.test/api/oauth/ml/status'] = { corpo: { authenticated: false } };
    rotas['GET http://analytics.test/api/tiny/status'] = { corpo: { authenticated: true } };
    rotas['GET http://nf.test/api/oauth/status'] = { corpo: { authenticated: true } };
    rotas['GET http://nf.test/api/oauth/ml/status'] = { corpo: { authenticated: true } };
    rotas['GET http://oc.test/api/admin/ml/status'] = { corpo: { configurado: true, conectado: false } };
    rotas['GET http://backup.test/painel/api/estado'] = { corpo: { versao: '0.9.2', ok: false, alertas: ['Batimento atrasado (12 min).'], servico: { batimentoMin: 12 }, meses: [{ mes: '2026-10', coleta: 'concluida', verificacao: 'ok' }], fila: { abertos: 0 } } };

    const r: any = await executarFerramenta('panorama_da_operacao', {});
    expect(r.vendas.ontemContraSemanaPassada.variacaoPercentual).toBe(-30);
    expect(r.vendas.mesmoDiaSemanaPassada.variacaoPercentual).toBeCloseTo(-16.7, 1);
    expect(r.pedidosENotas.totalBloqueados).toBe(1);
    expect(r.pedidosENotas.totalDespachoVenceHoje).toBe(1);
    expect(r.estoque.totalRompidos).toBe(1);
    expect(r.clientes.ocorrencias.abertas).toBe(3);
    expect(r.clientes.ocorrencias.semResponsavel).toHaveLength(1);
    expect(r.clientes.devolucoes.erro).toMatch(/Central de Ocorrencias/);
    expect(r.logins['ml-analytics'].mercadoLivre.valido).toBe(false);
    expect(r.logins['Central de Ocorrencias'].mercadoLivre.valido).toBe(false);
    expect(r.backupDoTiny.semAlerta).toBe(false);
    expect(r.backupDoTiny.mesesRecentes[0].mes).toBe('2026-10');
    const texto = r.pontosDeAtencao.join('\n');
    for (const esperado of ['Vendas de ontem -30%', '1 pedido(s) bloqueado', '1 nota(s) com erro', 'despacho vencendo hoje', 'estoque rompido', 'promocao vencendo', '1 pergunta(s) sem resposta', 'sem responsavel', 'prazo do ML', 'Login do Mercado Livre caiu no ml-analytics', 'Login do Mercado Livre caiu no Central de Ocorrencias', 'Backup do Tiny: Batimento atrasado']) {
      expect(texto).toContain(esperado);
    }
    expect(r.blocosComFalha).toBe(1);
  });

  it('com tudo fora do ar ainda responde, com erro em cada bloco', async () => {
    const r: any = await executarFerramenta('panorama_da_operacao', {});
    expect(r.vendas.erro).toBeTruthy();
    expect(r.pontosDeAtencao).toEqual(['Nada pedindo atencao nos dados disponiveis.']);
    expect(r.blocosComFalha).toBe(9);
    expect(r.backupDoTiny.erro).toBeTruthy();
  });
});

describe('v1.5: equipe, registro, backup e pedido no Tiny', () => {
  const equipe = [
    { id: 1, nome: 'Gerente Teste', email: 'g@x.com', papel: 'gerente', ativo: 1, ultimo_login: '2026-11-09' },
    { id: 2, nome: 'Bia Fila', email: 'b@x.com', papel: 'atendimento', ativo: 1 },
    { id: 3, nome: 'Antigo', email: 'a@x.com', papel: 'atendimento', ativo: 0 },
  ];

  it('equipe: conta a fila de cada pessoa ativa e a sem responsavel, sem e-mail', async () => {
    rotas['GET http://oc.test/api/admin/usuarios'] = { corpo: equipe };
    for (const [resp, totais] of [['1', [1, 0, 0]], ['2', [2, 1, 0]], ['nenhum', [3, 0, 0]]] as const) {
      ['nova', 'em_analise', 'aguardando_cliente'].forEach((st, i) => { rotas[`GET http://oc.test/api/admin/ocorrencias?status=${st}&responsavel=${resp}`] = { corpo: { total: totais[i], itens: [] } }; });
    }
    const r: any = await executarFerramenta('ocorrencias_equipe', {});
    expect(r.pessoasAtivas).toBe(2);
    expect(r.inativas).toBe(1);
    expect(r.equipe[0]).toMatchObject({ nome: 'Bia Fila', papel: 'atendimento', fila: { total: 3, porStatus: { nova: 2, em_analise: 1, aguardando_cliente: 0 } } });
    expect(r.semResponsavel.total).toBe(3);
    expect(JSON.stringify(r)).not.toContain('b@x.com');
  });

  it('lista com responsavel por nome: acha a pessoa e filtra pelo id; nome ambiguo ou inexistente vira erro', async () => {
    rotas['GET http://oc.test/api/admin/usuarios'] = { corpo: [...equipe, { id: 4, nome: 'Ana Dias', papel: 'atendimento', ativo: 1 }] };
    rotas['GET http://oc.test/api/admin/ocorrencias?responsavel=2'] = { corpo: { itens: [{ protocolo: 'P9', status: 'nova', responsavel: 'Bia Fila' }], total: 1, contagem: {} } };
    const r: any = await executarFerramenta('ocorrencias_lista', { responsavel: 'bia' });
    expect(r.itens[0].protocolo).toBe('P9');
    expect(((await executarFerramenta('ocorrencias_lista', { responsavel: 'zeca' })) as any).erro).toMatch(/Ninguem/);
    expect(((await executarFerramenta('ocorrencias_lista', { responsavel: 'ia' })) as any).erro).toMatch(/Mais de uma/);
  });

  it('registro: filtra por texto e nao repassa IP nem e-mail', async () => {
    rotas['GET http://oc.test/api/admin/registro?so=acessos'] = { corpo: [
      { id: 2, tipo: 'login', quem: 'Bia Fila', email: 'b@x.com', detalhe: null, ip: '10.0.0.1', criado_em: '2026-11-09 10:00' },
      { id: 1, tipo: 'login_falhou', quem: 'x@y.com', email: 'x@y.com', detalhe: 'senha errada', ip: '10.0.0.2', criado_em: '2026-11-09 09:00' },
    ] };
    const r: any = await executarFerramenta('ocorrencias_registro', { so: 'acessos', busca: 'bia' });
    expect(r.noFiltro).toBe(1);
    expect(r.linhas[0]).toMatchObject({ tipo: 'login', quem: 'Bia Fila' });
    expect(JSON.stringify(r)).not.toContain('10.0.0.1');
  });

  it('backup: manda x-api-key, resume os meses e le alertas; 404 explica a PANEL_API_KEY', async () => {
    rotas['GET http://backup.test/painel/api/estado'] = { corpo: { versao: '0.9.2', ok: true, alertas: [], servico: { batimentoMin: 1, janela: { liberada: false, texto: '01:00-06:00' } }, ultimas24h: { resumo: 'Backup do Tiny: resumo', porTipoEResultado: { 'coleta:ok': 2 } }, fila: { abertos: 1, itens: [] }, meses: [{ mes: '2026-10', notasNoTiny: 100, notasNoBackup: 100, coleta: 'concluida', verificacao: 'ok', drive: 'ok', selo: 'SEGURO_PARA_EXCLUSAO', exclusao: 'nenhuma' }, { mes: '2026-09' }, { mes: '2026-08' }, { mes: '2026-07' }], exclusoes: [], robo: { ligado: false }, drive: { configurado: true, envios: [] } } };
    const r: any = await executarFerramenta('backup_tiny_estado', { meses: 2 });
    expect(chamadas[0].init.headers['x-api-key']).toBe('chave-backup');
    expect(r.semAlerta).toBe(true);
    expect(r.mesesRecentes).toHaveLength(2);
    expect(r.mesesRecentes[0]).toMatchObject({ mes: '2026-10', selo: 'SEGURO_PARA_EXCLUSAO' });
    expect(r.resumo24h).toContain('Backup do Tiny');
    rotas['GET http://backup.test/painel/api/estado'] = { status: 404, corpo: { erro: 'Rota desligada' } };
    await expect(executarFerramenta('backup_tiny_estado', {})).rejects.toThrow(/PANEL_API_KEY/);
  });

  it('pedido no Tiny por numero: valida, traduz a situacao e diz se tem nota', async () => {
    rotas['GET http://nf.test/api/debug/tiny-find/2000123'] = { corpo: { total: 1, itens: [{ id: 77, numeroPedido: 555, situacao: 3, idNotaFiscal: 9, ecommerce: { nome: 'Shopee', numeroPedidoEcommerce: '2000123' }, dataCriacao: '2026-11-08', cliente: { nome: 'Ana' }, valor: '99.90' }] } };
    const r: any = await executarFerramenta('nf_buscar_pedido', { numero: '2000123' });
    expect(r.pedidos[0]).toMatchObject({ idTiny: 77, numeroTiny: 555, canal: 'Shopee', situacao: 'enviado', temNotaFiscal: true });
    expect(((await executarFerramenta('nf_buscar_pedido', { numero: '../x' })) as any).erro).toBeTruthy();
  });

  it('adesoes: junta as do ml-actions com as do analytics, marcando quem fez', async () => {
    rotas['GET http://analytics.test/api/promocoes/adesoes'] = { corpo: { items: [{ quando: '2026-11-05', itemId: 'MLB1', status: 'sucesso' }] } };
    rotas['GET http://actions.test/api/promocoes-historico'] = { corpo: { escritaHabilitada: true, items: [{ quando: '2026-11-07', itemId: 'MLB2', status: 'sucesso' }] } };
    const r: any = await executarFerramenta('ml_promocoes_aderidas', {});
    expect(r.total).toBe(2);
    expect(r.itens.map((i: any) => i.feitoPor)).toEqual(['ml-actions', 'ml-analytics']);
  });
});

describe('rotas do analytics que nao sao ferramentas la', () => {
  it('perguntas sem resposta: mais antigas primeiro e texto cortado', async () => {
    rotas['GET http://analytics.test/api/questions/pending'] = {
      corpo: { total: 2, questions: [{ itemId: 'MLB2', text: 'b', dateCreated: '2026-11-07' }, { itemId: 'MLB1', text: 'a'.repeat(400), dateCreated: '2026-11-01', itemTitle: 'Copo' }] },
    };
    const r: any = await executarFerramenta('ml_perguntas_sem_resposta', { limite: 5 });
    expect(r.itens[0].anuncio).toBe('Copo');
    expect(r.itens[0].pergunta).toHaveLength(300);
  });

  it('adesoes: filtra por status e nao manda o corpo nem a resposta crua do ML', async () => {
    rotas['GET http://analytics.test/api/promocoes/adesoes'] = {
      corpo: { escritaHabilitada: true, items: [
        { quando: '2026-11-05', itemId: 'MLB1', tipo: 'SMART', status: 'sucesso', corpo: { x: 1 }, respostaMl: { y: 2 } },
        { quando: '2026-11-06', itemId: 'MLB2', tipo: 'DEAL', status: 'erro', erro: 'preco fora da faixa', corpo: {}, respostaMl: {} },
      ] },
    };
    const r: any = await executarFerramenta('ml_promocoes_aderidas', { status: 'erro' });
    expect(r.porStatus).toEqual({ sucesso: 1, erro: 1 });
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].erro).toBe('preco fora da faixa');
    expect(JSON.stringify(r)).not.toContain('respostaMl');
  });
});
