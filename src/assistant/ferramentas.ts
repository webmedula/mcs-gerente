import { chamar, limitarResultado, NomeSistema, sistemas } from '../sistemas';
import { logger } from '../logger';

/**
 * FERRAMENTAS DO GERENTE (v1 — somente leitura).
 *
 * Mesmo principio do bot antigo: a IA nao ve os dados, ela escolhe uma funcao e recebe o
 * resultado pronto. Todo numero que chega ao usuario saiu de um dos sistemas.
 *
 * - ml-analytics: as ferramentas NAO ficam aqui. O Gerente pergunta ao analytics quais existem
 *   (GET /api/assistente/ferramentas) e pede pra executar. Ferramenta nova la aparece aqui sozinha.
 * - ml-actions, tiny-pedidos-nf e Central de Ocorrencias: as ferramentas ficam aqui e chamam as rotas GET que os paineis
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
        'Saude dos sistemas da MCS (ml-analytics, ml-actions, tiny-pedidos-nf e Central de Ocorrencias): se estao no ar, versao de cada um, se o login no Mercado Livre e no ' +
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
      const [aHealth, acHealth, acStatus, nfHealth, nfTiny, nfMl, nfAgenda, ocHealth, ocChave] = await Promise.all([
        tentar(() => chamar('analytics', '/health')),
        tentar(() => chamar('actions', '/health')),
        tentar(() => chamar('actions', '/api/status')),
        tentar(() => chamar('nf', '/health')),
        tentar(() => chamar('nf', '/api/oauth/status')),
        tentar(() => chamar('nf', '/api/oauth/ml/status')),
        tentar(() => chamar('nf', '/api/scheduler')),
        tentar(() => chamar('ocorrencias', '/healthz')),
        tentar(() => chamar('ocorrencias', '/api/admin/me')),
      ]);
      return {
        [s.analytics.rotulo]: { health: aHealth },
        [s.actions.rotulo]: { health: acHealth, status: acStatus },
        [s.nf.rotulo]: { health: nfHealth, loginTiny: nfTiny, loginMercadoLivre: nfMl, agendadorDeNotas: nfAgenda },
        [s.ocorrencias.rotulo]: { health: ocHealth, chaveDoGerente: ocChave },
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

  // ---------------------------------------------------------------- Central de Ocorrencias
  {
    sistema: 'ocorrencias',
    definicao: {
      name: 'ocorrencias_lista',
      description:
        'Ocorrencias de clientes na Central de Ocorrencias (reclamacoes do formulario e do Mercado Livre): ' +
        'quantas ha em cada status, e a lista filtrada, mais recentes primeiro, com protocolo, canal, pedido, ' +
        'assunto, status, responsavel, prazo do ML, devolucao e pendencia com o ML. Use para "quantas ' +
        'reclamacoes abertas", "o que esta sem responsavel", "ocorrencias do pedido X" ou "do cliente Y".',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['nova', 'em_analise', 'aguardando_cliente', 'resolvida', 'abertas'], description: '"abertas" = tudo que nao esta resolvido' },
          canal: { type: 'string', enum: ['mercado_livre', 'shopee', 'tiktok_shop', 'loja_propria'] },
          origem: { type: 'string', enum: ['ml', 'formulario'], description: 'ml = reclamacao aberta no Mercado Livre; formulario = cliente abriu pelo site' },
          pendencia: { type: 'string', enum: ['aguardando', 'creditou', 'negou', 'alguma'], description: 'pendencia de reembolso/credito com o Mercado Livre' },
          semResponsavel: { type: 'boolean', description: 'so as que ninguem da equipe assumiu' },
          busca: { type: 'string', description: 'protocolo, numero do pedido ou nome do cliente' },
          limite: { type: 'integer', description: 'quantas listar (1 a 20, padrao 10)' },
        },
      },
    },
    async executar(entrada) {
      const q = new URLSearchParams();
      const abertas = entrada?.status === 'abertas';
      if (typeof entrada?.status === 'string' && !abertas) q.set('status', entrada.status);
      for (const k of ['canal', 'origem', 'pendencia'] as const) if (typeof entrada?.[k] === 'string') q.set(k, entrada[k]);
      if (entrada?.semResponsavel) q.set('responsavel', 'nenhum');
      if (typeof entrada?.busca === 'string' && entrada.busca.trim()) q.set('q', entrada.busca.trim().slice(0, 80));
      const limite = limitar(entrada?.limite, 10);
      const qs = q.toString();
      const r = await chamar('ocorrencias', `/api/admin/ocorrencias${qs ? `?${qs}` : ''}`);
      let itens: any[] = r?.itens ?? [];
      // A Central nao tem filtro "abertas": tira as resolvidas da pagina (25 por pagina, mais recentes).
      if (abertas) itens = itens.filter((i) => i.status !== 'resolvida');
      const contagem: Record<string, number> = r?.contagem ?? {};
      return {
        contagemGeralPorStatus: contagem,
        abertasNoTotal: Object.entries(contagem).filter(([k]) => k !== 'resolvida').reduce((t, [, n]) => t + Number(n), 0),
        pendenciasComMlAguardando: r?.pendencias,
        totalNoFiltro: abertas ? undefined : r?.total,
        observacao: abertas && Number(r?.total) > itens.length
          ? 'Filtro "abertas" olha so as 25 ocorrencias mais recentes; use status especifico para a contagem exata.'
          : undefined,
        itens: itens.slice(0, limite).map((i) => ({
          protocolo: i.protocolo,
          origem: i.origem,
          canal: r?.canais?.[i.canal] ?? i.canal,
          pedido: i.pedido,
          assunto: r?.tipos?.[i.tipo] ?? i.tipo,
          cliente: i.nome,
          status: r?.status?.[i.status] ?? i.status,
          responsavel: i.responsavel ?? null,
          prazoMl: i.prazo_em ?? undefined,
          devolucao: i.devolucao ?? undefined,
          pendenciaMl: i.pendencia_ml && i.pendencia_ml !== 'nenhuma' ? i.pendencia_ml : undefined,
          produto: i.produto?.titulo ?? undefined,
          abertaEm: i.criado_em,
          atualizadaEm: i.atualizado_em,
        })),
      };
    },
  },
  {
    sistema: 'ocorrencias',
    definicao: {
      name: 'ocorrencias_detalhe',
      description:
        'Tudo sobre UMA ocorrencia pelo protocolo: o que o cliente relatou, status, responsavel, produto, ' +
        'historico (ultimas anotacoes e respostas), mensagens da reclamacao no Mercado Livre, devolucao, ' +
        'desfecho e custo, conta da venda no ML e pesquisa de satisfacao. Se so tiver o numero do pedido, ' +
        'ache o protocolo antes com ocorrencias_lista (busca).',
      input_schema: {
        type: 'object',
        properties: { protocolo: { type: 'string', description: 'protocolo da ocorrencia' } },
        required: ['protocolo'],
      },
    },
    async executar(entrada) {
      const protocolo = String(entrada?.protocolo || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,40}$/.test(protocolo)) return { erro: 'Informe o protocolo da ocorrencia (letras, numeros e hifen).' };
      const o = await chamar('ocorrencias', `/api/admin/ocorrencias/${protocolo}`);
      const ultimos = <T>(l: T[] | undefined, n: number) => (Array.isArray(l) ? l.slice(-n) : []);
      const claim = o?.ml?.claim;
      return {
        protocolo: o?.protocolo,
        origem: o?.origem,
        canal: o?.canal,
        pedido: o?.pedido,
        assunto: o?.tipo,
        status: o?.status,
        cliente: o?.nome,
        relato: typeof o?.descricao === 'string' ? o.descricao.slice(0, 1500) : o?.descricao,
        abertaEm: o?.criado_em,
        atualizadaEm: o?.atualizado_em,
        resolvidaEm: o?.resolvida_em,
        prazoMl: o?.prazo_em,
        responsavel: o?.responsavel?.nome ?? null,
        desfecho: o?.desfecho,
        custo: o?.custo_centavos != null ? o.custo_centavos / 100 : null,
        produtos: (o?.produtos ?? []).map((p: any) => p?.titulo ?? p?.descricao ?? p?.codigo),
        fotosDoCliente: Array.isArray(o?.anexos) ? o.anexos.length : 0,
        historico: ultimos(o?.eventos, 10).map((e: any) => ({
          em: e.criado_em, autor: e.do_cliente ? 'cliente' : e.autor ?? 'sistema', publico: !!e.publico, texto: String(e.texto ?? '').slice(0, 500),
        })),
        historicoTotal: o?.eventos?.length ?? 0,
        mercadoLivre: o?.ml
          ? {
              etapa: claim?.stage, statusReclamacao: claim?.status, motivo: claim?.reason_id, encerrada: o.ml.encerrada,
              resolucao: claim?.resolution ?? undefined,
              mensagens: ultimos(o.ml.mensagens, 8).map((m: any) => ({
                em: m.data, de: m.remetente, para: m.destinatario, texto: String(m.texto ?? '').slice(0, 500),
              })),
              mensagensTotal: o.ml.mensagens?.length ?? 0,
            }
          : undefined,
        devolucao: o?.devolucao
          ? {
              status: o.devolucao.statusRotulo, tipo: o.devolucao.tipo, envio: o.devolucao.envio, datas: o.devolucao.datas,
              conferencia: o.devolucao.conferenciaRotulo, conferenciaObs: o.devolucao.conferenciaObs,
              custos: o.devolucao.custos, contestacao: o.devolucao.contestacao?.status ? o.devolucao.contestacao : undefined,
            }
          : undefined,
        contaDaVenda: o?.conta
          ? {
              preco: o.conta.preco, tarifa: o.conta.tarifa, envios: o.conta.envios, reembolso: o.conta.reembolso,
              creditos: o.conta.creditos, custoProduto: o.conta.custoProduto, totalMl: o.conta.totalMl, resultado: o.conta.resultado,
              pendencia: o.conta.pendenciaRotulo, reputacaoAfetada: o.conta.reputacaoAfetada,
            }
          : undefined,
        pesquisa: o?.pesquisa ?? undefined,
      };
    },
  },
  {
    sistema: 'ocorrencias',
    definicao: {
      name: 'ocorrencias_numeros',
      description:
        'Numeros da Central de Ocorrencias num periodo (7, 30, 90 ou 365 dias): total aberto, abertas agora, ' +
        'resolvidas, tempo medio de primeira resposta e de resolucao (horas), custo das resolucoes por desfecho, ' +
        'satisfacao dos clientes, divisao por canal, assunto e origem, serie semanal e quanto as reclamacoes ' +
        'do Mercado Livre custaram (por mes, por produto e por motivo).',
      input_schema: {
        type: 'object',
        properties: { dias: { type: 'integer', enum: [7, 30, 90, 365], description: 'padrao 30' } },
      },
    },
    async executar(entrada) {
      const dias = [7, 30, 90, 365].includes(Number(entrada?.dias)) ? Number(entrada.dias) : 30;
      const r = await chamar('ocorrencias', `/api/admin/estatisticas?dias=${dias}`);
      // Os dicionarios de rotulos so servem pra traduzir as chaves; troca na resposta e tira.
      const { canais = {}, tipos = {}, desfechos = {}, ...resto } = r ?? {};
      const rotular = (lista: any[] | undefined, mapa: Record<string, string>) =>
        Array.isArray(lista) ? lista.map((x) => ({ ...x, k: mapa[x.k] ?? x.k })) : lista;
      return {
        ...resto,
        porCanal: rotular(resto.porCanal, canais),
        porTipo: rotular(resto.porTipo, tipos),
        porDesfecho: rotular(resto.porDesfecho, desfechos),
        contaMl: resto.contaMl ? { ...resto.contaMl, porMotivo: rotular(resto.contaMl.porMotivo, tipos) } : undefined,
      };
    },
  },
  {
    sistema: 'ocorrencias',
    definicao: {
      name: 'ocorrencias_devolucoes',
      description:
        'Fila de devolucoes do Mercado Livre na Central de Ocorrencias, as que pedem acao primeiro ' +
        '(aguardando liberacao, recebidas a conferir, nao entregues, em contestacao): quantas em cada etapa, ' +
        'rastreio, conferencia do produto que voltou e custo da devolucao.',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['aguardando_liberacao', 'liberada', 'em_transito', 'nao_entregue', 'recebida', 'conferida', 'em_contestacao', 'encerrada', 'cancelada'],
          },
          busca: { type: 'string', description: 'protocolo, pedido, cliente ou rastreio' },
          limite: { type: 'integer', description: '1 a 20, padrao 10' },
        },
      },
    },
    async executar(entrada) {
      const q = new URLSearchParams();
      if (typeof entrada?.status === 'string') q.set('status', entrada.status);
      if (typeof entrada?.busca === 'string' && entrada.busca.trim()) q.set('q', entrada.busca.trim().slice(0, 80));
      const qs = q.toString();
      const r = await chamar('ocorrencias', `/api/admin/devolucoes${qs ? `?${qs}` : ''}`);
      const rotulos: Record<string, string> = r?.status ?? {};
      return {
        contagemPorEtapa: Object.fromEntries(Object.entries(r?.contagem ?? {}).map(([k, n]) => [rotulos[k] ?? k, n])),
        totalNoFiltro: r?.total,
        itens: (r?.itens ?? []).slice(0, limitar(entrada?.limite, 10)).map((d: any) => ({
          protocolo: d.protocolo, pedido: d.pedido, cliente: d.nome, produto: d.produto?.titulo,
          etapa: rotulos[d.status] ?? d.status, tipo: d.tipo, rastreio: d.rastreio, envio: d.envio_status,
          abertaEm: d.aberta_em, recebidaEm: d.recebida_em, prazoMl: d.prazo_em,
          conferencia: r?.conferencias?.[d.conferencia] ?? d.conferencia ?? undefined,
          contestacao: d.contestacao_status ?? undefined, custo: d.custo, responsavel: d.responsavel ?? null,
        })),
      };
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
  // Central de Ocorrencias e opcional: sem URL, as ferramentas dela nem aparecem pro modelo.
  const semOcorrencias = !sistemas().ocorrencias.baseUrl;
  if (semOcorrencias) {
    avisos.push('A Central de Ocorrencias nao esta ligada ao Gerente (falta OCORRENCIAS_BASE_URL). ' +
      'Perguntas sobre reclamacoes e devolucoes de clientes nao podem ser respondidas por aqui.');
  }
  const locais = FERRAMENTAS_LOCAIS.filter((f) => !(semOcorrencias && f.sistema === 'ocorrencias'));
  const porSistema: Record<string, string[]> = { analytics: doAnalytics.map((f) => f.name) };
  for (const f of locais) (porSistema[f.sistema] ??= []).push(f.definicao.name);
  return {
    ferramentas: [...doAnalytics, ...locais.map((f) => f.definicao)],
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
