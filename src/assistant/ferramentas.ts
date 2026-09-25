import { chamar, limitarResultado, NomeSistema, sistemas } from '../sistemas';
import { logger } from '../logger';

/**
 * FERRAMENTAS DO GERENTE (v1 — somente leitura).
 *
 * Mesmo principio do bot antigo: a IA nao ve os dados, ela escolhe uma funcao e recebe o
 * resultado pronto. Todo numero que chega ao usuario saiu de um dos tres sistemas.
 *
 * - ml-analytics: as ferramentas NAO ficam aqui. O Gerente pergunta ao analytics quais existem
 *   (GET /api/assistente/ferramentas) e pede pra executar. Ferramenta nova la aparece aqui sozinha.
 * - ml-actions e tiny-pedidos-nf: as ferramentas ficam aqui e chamam as rotas GET que os paineis
 *   deles ja usam. Cada uma resume a resposta — lista crua de 300 pedidos nao cabe no contexto.
 */

export interface DefinicaoDeFerramenta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface FerramentaLocal {
  sistema: NomeSistema | 'geral';
  definicao: DefinicaoDeFerramenta;
  executar: (entrada: any) => Promise<unknown>;
}

const limitar = (v: unknown, padrao: number, teto = 20): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(teto, Math.max(1, Math.trunc(n))) : padrao;
};

const dataValida = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

function contarPor<T>(lista: T[], chave: (t: T) => string): Record<string, number> {
  const r: Record<string, number> = {};
  for (const t of lista) {
    const k = chave(t);
    r[k] = (r[k] ?? 0) + 1;
  }
  return r;
}

// ------------------------------------------------------------------------- ferramentas locais

export const FERRAMENTAS_LOCAIS: FerramentaLocal[] = [
  // ---------------------------------------------------------------- geral
  {
    sistema: 'geral',
    definicao: {
      name: 'estado_dos_sistemas',
      description:
        'Saude dos tres sistemas da MCS: se estao no ar, versao de cada um, se o login no Mercado Livre e no ' +
        'Tiny esta valido, se a escrita do ml-actions esta ligada e como esta o agendador automatico de notas ' +
        '(ligado, intervalo, ultima e proxima execucao). Use quando perguntarem se algo esta funcionando, ' +
        'ou quando outra ferramenta falhar e for preciso entender por que.',
      input_schema: { type: 'object', properties: {} },
    },
    async executar() {
      const tentar = async (fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch (err: any) {
          return { erro: err?.message || String(err) };
        }
      };
      const s = sistemas();
      const [aHealth, acHealth, acStatus, nfHealth, nfTiny, nfMl, nfAgenda] = await Promise.all([
        tentar(() => chamar('analytics', '/health')),
        tentar(() => chamar('actions', '/health')),
        tentar(() => chamar('actions', '/api/status')),
        tentar(() => chamar('nf', '/health')),
        tentar(() => chamar('nf', '/api/oauth/status')),
        tentar(() => chamar('nf', '/api/oauth/ml/status')),
        tentar(() => chamar('nf', '/api/scheduler')),
      ]);
      return {
        [s.analytics.rotulo]: { health: aHealth },
        [s.actions.rotulo]: { health: acHealth, status: acStatus },
        [s.nf.rotulo]: { health: nfHealth, loginTiny: nfTiny, loginMercadoLivre: nfMl, agendadorDeNotas: nfAgenda },
      };
    },
  },

  // ---------------------------------------------------------------- ml-actions
  {
    sistema: 'actions',
    definicao: {
      name: 'recriacao_candidatos',
      description:
        'Fila de anuncios candidatos a RECRIACAO no ml-actions (anuncios com nota baixa em que recriar pode ' +
        'zerar a avaliacao), na ordem em que vale trabalhar. So consulta: o Gerente nao recria anuncio.',
      input_schema: {
        type: 'object',
        properties: { limite: { type: 'integer', description: 'quantos itens (1 a 20, padrao 10)' } },
      },
    },
    async executar(entrada) {
      const r = await chamar('actions', '/api/candidates');
      const itens: any[] = r?.items ?? [];
      return {
        disponivel: r?.disponivel,
        motivo: r?.motivo,
        atualizadoEm: r?.atualizadoEm,
        fonte: r?.fonte,
        totalNaFila: itens.length,
        ocultados: r?.ocultados,
        itens: itens.slice(0, limitar(entrada?.limite, 10)),
      };
    },
  },
  {
    sistema: 'actions',
    definicao: {
      name: 'recriacao_historico',
      description:
        'Historico das recriacoes de anuncio ja executadas pelo ml-actions: anuncio antigo e novo, data, ' +
        'status (sucesso / falha / parcial), etapa que falhou e erro. Mais recentes primeiro.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['sucesso', 'falha', 'parcial'] },
          limite: { type: 'integer', description: '1 a 20, padrao 10' },
        },
      },
    },
    async executar(entrada) {
      const r = await chamar('actions', '/api/listings/recreations');
      let itens: any[] = Array.isArray(r?.items) ? r.items : [];
      itens = [...itens].sort((a, b) => String(b.executadoEm).localeCompare(String(a.executadoEm)));
      const totalPorStatus = contarPor(itens, (i) => String(i.status));
      if (entrada?.status) itens = itens.filter((i) => i.status === entrada.status);
      return {
        escritaHabilitadaNoActions: r?.escritaHabilitada,
        total: Object.values(totalPorStatus).reduce((t, n) => t + n, 0),
        totalPorStatus,
        // O snapshot do anuncio antigo (usado pra rollback) e enorme e nao ajuda a responder.
        itens: itens.slice(0, limitar(entrada?.limite, 10)).map((i) => ({
          itemAntigo: i.itemAntigo,
          itemNovo: i.itemNovo,
          titulo: i.titulo,
          executadoEm: i.executadoEm,
          status: i.status,
          notaAntiga: i.notaAntiga,
          vendasPerdidas: i.vendasPerdidas,
          estoqueTransferido: i.estoqueTransferido,
          etapaQueFalhou: i.etapaQueFalhou,
          erro: i.erro,
          sondagem: i.sondagem ? { veredicto: i.sondagem.veredicto, explicacao: i.sondagem.explicacao } : undefined,
        })),
      };
    },
  },
  {
    sistema: 'actions',
    definicao: {
      name: 'recriacao_formas',
      description:
        'Diagnostico, sem criar nada, de em qual formato o Mercado Livre aceitaria recriar UM anuncio ' +
        '(familia, variacoes, atributos). Use quando perguntarem por que a recriacao de um MLB esta falhando ' +
        'ou o que falta pra recriar.',
      input_schema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'codigo MLB do anuncio, ex.: MLB1234567890' },
          familia: { type: 'string', description: 'nome de familia a testar (opcional)' },
        },
        required: ['itemId'],
      },
    },
    async executar(entrada) {
      const itemId = String(entrada?.itemId || '').trim().toUpperCase();
      if (!/^MLB\d{5,}$/.test(itemId)) return { erro: 'Informe o codigo MLB completo (ex.: MLB1234567890).' };
      const q = entrada?.familia ? `?familia=${encodeURIComponent(String(entrada.familia))}` : '';
      return chamar('actions', `/api/listings/${itemId}/formas${q}`);
    },
  },

  // ---------------------------------------------------------------- tiny-pedidos-nf
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_pedidos_pendentes',
      description:
        'Pedidos em aberto no Tiny que o tiny-pedidos-nf acompanha pra aplicar desconto e emitir nota: quantos ' +
        'por canal, quantos ja estao prontos pra NF, quais estao bloqueados e por que, prazos de despacho. ' +
        'Vem do ultimo retrato da varredura automatica (informa quando foi).',
      input_schema: {
        type: 'object',
        properties: {
          marketplace: { type: 'string', enum: ['shopee', 'ml', 'tiktok'], description: 'filtra o canal (opcional)' },
          filtro: { type: 'string', enum: ['todos', 'prontos_para_nf', 'bloqueados', 'nao_processados'] },
          limite: { type: 'integer', description: 'quantos pedidos listar (1 a 20, padrao 10)' },
        },
      },
    },
    async executar(entrada) {
      const mkt = ['shopee', 'ml', 'tiktok'].includes(entrada?.marketplace) ? `?marketplace=${entrada.marketplace}` : '';
      const r = await chamar('nf', `/api/orders/pending${mkt}`);
      const todos: any[] = r?.orders ?? [];
      const filtro = String(entrada?.filtro || 'todos');
      const filtrados =
        filtro === 'prontos_para_nf' ? todos.filter((o) => o.prontoParaNf)
        : filtro === 'bloqueados' ? todos.filter((o) => o.bloqueado)
        : filtro === 'nao_processados' ? todos.filter((o) => !o.jaProcessado)
        : todos;
      return {
        retratoDe: r?.atualizadoEm,
        varreduraEmAndamento: r?.atualizando,
        erroNaUltimaVarredura: r?.erro || undefined,
        total: todos.length,
        porCanal: contarPor(todos, (o) => o.marketplace || 'sem canal'),
        prontosParaNf: todos.filter((o) => o.prontoParaNf).length,
        bloqueados: todos.filter((o) => o.bloqueado).length,
        jaProcessados: todos.filter((o) => o.jaProcessado).length,
        filtro,
        totalNoFiltro: filtrados.length,
        itens: filtrados.slice(0, limitar(entrada?.limite, 10)).map((o) => ({
          id: o.id,
          numeroPedido: o.numeroPedido,
          numeroNoMarketplace: o.numeroPedidoEcommerce,
          canal: o.marketplace,
          cliente: o.cliente,
          valor: o.valor,
          criadoEm: o.dataCriacao,
          limiteDespacho: o.dataLimiteDespacho ?? o.dataPrevista,
          prontoParaNf: o.prontoParaNf,
          jaProcessado: o.jaProcessado,
          bloqueado: o.bloqueado,
          motivoBloqueio: o.motivoBloqueio,
          substatusMl: o.mlSubstatus,
        })),
      };
    },
  },
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_previa_pedido',
      description:
        'Simula, sem alterar nada no Tiny, o que o tiny-pedidos-nf faria com UM pedido: lista de preco ' +
        'encontrada, percentual de desconto, valor de cada item antes e depois, total da nota e avisos. ' +
        'Aceita o numero do pedido no Tiny, o numero no marketplace ou o id interno.',
      input_schema: {
        type: 'object',
        properties: { pedido: { type: 'string', description: 'numero do pedido, numero no marketplace ou id interno' } },
        required: ['pedido'],
      },
    },
    async executar(entrada) {
      const busca = String(entrada?.pedido || '').trim();
      if (!busca) return { erro: 'Informe o numero do pedido.' };
      // O preview pede o ID INTERNO do Tiny, mas o usuario fala o numero do pedido. Traduz pela
      // lista de pendentes; se nao achar e for numerico, tenta como id interno mesmo.
      const r = await chamar('nf', '/api/orders/pending');
      const achado = (r?.orders ?? []).find(
        (o: any) => String(o.numeroPedido) === busca || String(o.numeroPedidoEcommerce) === busca || String(o.id) === busca,
      );
      const id = achado?.id ?? (/^\d+$/.test(busca) ? busca : null);
      if (id == null) return { encontrado: false, mensagem: `Pedido "${busca}" nao esta entre os pendentes.` };
      const previa = await chamar('nf', `/api/orders/${id}/preview`);
      return {
        observacao: achado ? undefined : 'Pedido nao esta na lista de pendentes; consultado como id interno do Tiny.',
        ...previa,
      };
    },
  },
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_processados',
      description:
        'Pedidos ja processados pelo tiny-pedidos-nf (desconto aplicado e nota emitida), com numero da nota, ' +
        'chave de acesso, desconto aplicado e erros. status: success (nota emitida), error (falhou), ' +
        'adjusted (desconto aplicado mas nota ainda nao emitida — requer atencao). Mais recentes primeiro.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['success', 'error', 'adjusted'] },
          desde: { type: 'string', description: 'YYYY-MM-DD: so processados a partir desta data (opcional)' },
          pedido: { type: 'string', description: 'numero do pedido especifico (opcional)' },
          limite: { type: 'integer', description: '1 a 20, padrao 10' },
        },
      },
    },
    async executar(entrada) {
      const r = await chamar('nf', '/api/processed');
      let itens: any[] = [...(r?.processed ?? [])].sort((a, b) => String(b.processedAt).localeCompare(String(a.processedAt)));
      const desde = dataValida(entrada?.desde);
      if (desde) itens = itens.filter((i) => String(i.processedAt) >= desde);
      if (entrada?.pedido) itens = itens.filter((i) => String(i.numeroPedido) === String(entrada.pedido) || String(i.orderId) === String(entrada.pedido));
      const porStatus = contarPor(itens, (i) => String(i.status));
      if (entrada?.status) itens = itens.filter((i) => i.status === entrada.status);
      return {
        periodo: desde ? `desde ${desde}` : 'todo o historico guardado',
        porStatus,
        totalNoFiltro: itens.length,
        itens: itens.slice(0, limitar(entrada?.limite, 10)),
      };
    },
  },
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_lotes',
      description:
        'Lotes de emissao de nota executados recentemente (os 20 ultimos que o tiny-pedidos-nf guarda em ' +
        'memoria): quantos pedidos, quantos deram certo, quais falharam e por que.',
      input_schema: { type: 'object', properties: { limite: { type: 'integer', description: '1 a 20, padrao 5' } } },
    },
    async executar(entrada) {
      const r = await chamar('nf', '/api/jobs');
      const jobs: any[] = [...(r?.jobs ?? [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      return {
        total: jobs.length,
        lotes: jobs.slice(0, limitar(entrada?.limite, 5)).map((j) => {
          const res: any[] = j.results ?? [];
          return {
            id: j.id,
            status: j.status,
            iniciadoEm: j.startedAt,
            terminadoEm: j.finishedAt,
            pedidos: j.total,
            concluidos: j.done,
            sucesso: res.filter((x) => x.success).length,
            pulados: res.filter((x) => x.skipped).length,
            falhas: res
              .filter((x) => !x.success && !x.skipped)
              .slice(0, 10)
              .map((x) => ({ numeroPedido: x.numeroPedido, erro: x.error || x.reason })),
          };
        }),
      };
    },
  },
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_vendas_do_dia',
      description:
        'Vendas de UM dia segundo o Tiny (todos os canais, exceto cancelados): pedidos, venda real (o que o ' +
        'cliente pagou), faturado em nota, ticket medio, divisao por canal e por hora. Use para "quanto ' +
        'vendemos hoje/ontem". Passe a data no fuso de Sao Paulo.',
      input_schema: {
        type: 'object',
        properties: { data: { type: 'string', description: 'YYYY-MM-DD' } },
        required: ['data'],
      },
    },
    async executar(entrada) {
      const data = dataValida(entrada?.data);
      if (!data) return { erro: 'Informe a data no formato YYYY-MM-DD.' };
      const r = await chamar('nf', `/api/sales-report?data=${data}`);
      const rep = r?.report ?? {};
      return {
        atualizadoEm: r?.atualizadoEm,
        ...rep,
        // Hora sem venda so ocupa espaco.
        horas: Array.isArray(rep.horas) ? rep.horas.filter((h: any) => h.pedidos > 0) : rep.horas,
      };
    },
  },
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_painel',
      description:
        'Painel do tiny-pedidos-nf: vendas de hoje, serie diaria dos ultimos N dias, participacao por canal ' +
        'e produtos mais vendidos em 7 dias, e a situacao da operacao (pendentes por canal, prontos pra NF, ' +
        'aguardando o ML, processados hoje e erros de hoje). Bom pra comparar dias e ver tendencia de vendas ' +
        'em todos os canais (nao so Mercado Livre).',
      input_schema: {
        type: 'object',
        properties: { dias: { type: 'integer', description: 'tamanho da serie diaria (1 a 90, padrao 30)' } },
      },
    },
    async executar(entrada) {
      return chamar('nf', `/api/dashboard?dias=${limitar(entrada?.dias, 30, 90)}`);
    },
  },
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_listas_de_preco',
      description:
        'Qual lista de preco do Tiny o tiny-pedidos-nf usa para cada marketplace (Shopee, Mercado Livre, ' +
        'TikTok) e o percentual de desconto aplicado nos pedidos antes de emitir a nota.',
      input_schema: { type: 'object', properties: {} },
    },
    async executar() {
      return chamar('nf', '/api/price-lists');
    },
  },
];

// ------------------------------------------------------------------ ferramentas do ml-analytics

const CACHE_ANALYTICS_MS = 10 * 60 * 1000;
let cacheAnalytics: { em: number; ferramentas: DefinicaoDeFerramenta[] } | null = null;
let erroAnalytics: string | null = null;

/** Busca a lista do analytics. Cache de 10 min; se ele cair, usa a ultima lista conhecida. */
async function ferramentasDoAnalytics(forcar = false): Promise<DefinicaoDeFerramenta[]> {
  if (!forcar && cacheAnalytics && Date.now() - cacheAnalytics.em < CACHE_ANALYTICS_MS) return cacheAnalytics.ferramentas;
  try {
    const r = await chamar('analytics', '/api/assistente/ferramentas', { timeoutMs: 8000 });
    const locais = new Set(FERRAMENTAS_LOCAIS.map((f) => f.definicao.name));
    const lista: DefinicaoDeFerramenta[] = (r?.ferramentas ?? []).filter((f: any) => {
      // Nome repetido quebraria a chamada ao modelo. A local vence e o conflito vai pro log.
      if (locais.has(f?.name)) {
        logger.warn(`[FERRAMENTAS] "${f.name}" existe no analytics e no Gerente; usando a do Gerente.`);
        return false;
      }
      return typeof f?.name === 'string' && f?.input_schema;
    });
    cacheAnalytics = { em: Date.now(), ferramentas: lista };
    erroAnalytics = null;
    return lista;
  } catch (err: any) {
    erroAnalytics = err?.message || String(err);
    logger.warn('[FERRAMENTAS] Nao consegui a lista do ml-analytics:', erroAnalytics);
    return cacheAnalytics?.ferramentas ?? [];
  }
}

export interface CatalogoDeFerramentas {
  ferramentas: DefinicaoDeFerramenta[];
  /** Avisos pro modelo, ex.: "ml-analytics fora: as ferramentas dele nao estao disponiveis". */
  avisos: string[];
  porSistema: Record<string, string[]>;
}

export async function catalogo(forcar = false): Promise<CatalogoDeFerramentas> {
  const doAnalytics = await ferramentasDoAnalytics(forcar);
  const avisos: string[] = [];
  if (doAnalytics.length === 0) {
    avisos.push(`As ferramentas do ml-analytics estao indisponiveis agora (${erroAnalytics || 'lista vazia'}). ` +
      'Perguntas sobre margem, Buy Box, reposicao e SQL do Mercado Livre nao podem ser respondidas no momento.');
  }
  const porSistema: Record<string, string[]> = { analytics: doAnalytics.map((f) => f.name) };
  for (const f of FERRAMENTAS_LOCAIS) (porSistema[f.sistema] ??= []).push(f.definicao.name);
  return {
    ferramentas: [...doAnalytics, ...FERRAMENTAS_LOCAIS.map((f) => f.definicao)],
    avisos,
    porSistema,
  };
}

export async function executarFerramenta(nome: string, entrada: any): Promise<unknown> {
  const local = FERRAMENTAS_LOCAIS.find((f) => f.definicao.name === nome);
  if (local) return limitarResultado(await local.executar(entrada ?? {}));

  const doAnalytics = await ferramentasDoAnalytics();
  if (doAnalytics.some((f) => f.name === nome)) {
    const r = await chamar('analytics', `/api/assistente/ferramenta/${nome}`, { metodo: 'POST', corpo: { entrada: entrada ?? {} } });
    return limitarResultado(r?.saida);
  }
  return { erro: `Ferramenta desconhecida: ${nome}` };
}

/** So pra testes. */
export function _limparCacheAnalytics(): void {
  cacheAnalytics = null;
  erroAnalytics = null;
}
