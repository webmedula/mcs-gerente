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
 * - ml-actions, tiny-pedidos-nf, Central de Ocorrencias e Backup do Tiny: as ferramentas ficam aqui e chamam as rotas GET
 *   que os paineis deles ja usam. Cada uma resume a resposta — lista crua de 300 pedidos nao cabe no contexto.
 * - v1.5 ("acesso a tudo"): equipe e fila de cada pessoa, registro de atividades, ML e backups da Central; estado do
 *   Backup do Tiny; pedido no Tiny por numero; adesoes feitas pelo ml-actions. Continua so leitura.
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

/** Erro vira dado: num panorama, um sistema fora nao pode derrubar os outros. */
async function tentar<T>(fn: () => Promise<T>): Promise<T | { erro: string }> {
  try {
    return await fn();
  } catch (err: any) {
    return { erro: err?.message || String(err) };
  }
}
const falhou = (r: unknown): r is { erro: string } => !!r && typeof r === 'object' && 'erro' in (r as any);

/** Mesmo dia da semana anterior (YYYY-MM-DD), no fuso de Sao Paulo. */
function dataEmBrasilia(deslocDias = 0): string {
  const d = new Date(Date.now() + deslocDias * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Executa uma ferramenta do analytics e devolve so a saida dela. */
async function ferramentaDoAnalytics(nome: string, entrada: Record<string, unknown>): Promise<any> {
  const r = await chamar('analytics', `/api/assistente/ferramenta/${nome}`, { metodo: 'POST', corpo: { entrada } });
  return r?.saida;
}

const variacao = (hoje: number | null | undefined, antes: number | null | undefined): number | null =>
  hoje == null || antes == null || antes === 0 ? null : Math.round(((hoje - antes) / antes) * 1000) / 10;

/** Resumo do GET /painel/api/estado do backup (0.9.2): o que importa pra conversa, sem a lista inteira. */
function resumoDoBackup(r: any) {
  const meses: any[] = Array.isArray(r?.meses) ? r.meses : [];
  return {
    versao: r?.versao,
    semAlerta: r?.ok,
    alertas: r?.alertas ?? [],
    batimentoHaMinutos: r?.servico?.batimentoMin,
    janelaDeColeta: r?.servico?.janela,
    pausas: r?.servico?.pausas,
    disco: r?.servico?.disco,
    filaAberta: r?.fila?.abertos,
    ultimas24h: r?.ultimas24h?.porTipoEResultado,
    mesesRecentes: meses.slice(0, 3).map((m) => ({ mes: m.mes, notasNoTiny: m.notasNoTiny, notasNoBackup: m.notasNoBackup, coleta: m.coleta, verificacao: m.verificacao, drive: m.drive, selo: m.selo, exclusao: m.exclusao })),
    robo: r?.robo,
    drive: r?.drive,
  };
}

/** Lancamentos brutos do ML de uma ocorrencia: so o que explica a conta (sem o JSON cru da API). */
function resumirLancamentosMl(bruto: any) {
  const linhas: any[] = Array.isArray(bruto) ? bruto : Array.isArray(bruto?.lancamentos) ? bruto.lancamentos : Array.isArray(bruto?.results) ? bruto.results : [];
  const centavos = (v: unknown) => (typeof v === 'number' ? Math.round(v) / 100 : undefined);
  return {
    total: linhas.length,
    lancamentos: linhas.slice(0, 20).map((l) => ({
      data: l.data ?? l.date ?? l.period ?? undefined, categoria: l.categoria ?? l.category ?? undefined, tipo: l.tipo ?? l.type ?? undefined,
      descricao: String(l.descricao ?? l.description ?? l.detail ?? '').slice(0, 120) || undefined,
      valor: centavos(l.valor_centavos) ?? l.valor ?? l.amount ?? undefined, pedido: l.pedido ?? l.order_id ?? undefined, debitado: l.debitado ?? undefined,
    })),
    observacao: linhas.length > 20 ? 'Mostrando os 20 primeiros lancamentos.' : undefined,
  };
}

/** Acha alguem da equipe da Central pelo nome (ou parte). Ambiguidade vira erro com as opcoes. */
async function acharPessoa(nome: string): Promise<{ id: number; nome: string } | { erro: string }> {
  const busca = nome.trim().toLowerCase();
  const equipe: any[] = (await chamar('ocorrencias', '/api/admin/usuarios')) ?? [];
  const ativos = equipe.filter((u) => u.ativo !== 0 && u.ativo !== false);
  const achados = ativos.filter((u) => String(u.nome ?? '').toLowerCase().includes(busca));
  if (achados.length === 1) return { id: achados[0].id, nome: achados[0].nome };
  if (achados.length === 0) return { erro: `Ninguem da equipe da Central se chama "${nome}". Pessoas ativas: ${ativos.map((u) => u.nome).join(', ') || 'nenhuma'}.` };
  return { erro: `Mais de uma pessoa bate com "${nome}": ${achados.map((u) => u.nome).join(', ')}. Diga o nome completo.` };
}

// ------------------------------------------------------------------------- ferramentas locais

export const FERRAMENTAS_LOCAIS: FerramentaLocal[] = [
  // ---------------------------------------------------------------- geral
  {
    sistema: 'geral',
    definicao: {
      name: 'estado_dos_sistemas',
      description:
        'Saude dos cinco sistemas da MCS (ml-analytics, ml-actions, tiny-pedidos-nf, Central de Ocorrencias e Backup do Tiny): se estao no ar, versao de cada um, se o login no Mercado Livre e no ' +
        'Tiny esta valido (inclusive o ML da Central), se a escrita do ml-actions esta ligada, como esta o agendador automatico de notas ' +
        '(ligado, intervalo, ultima e proxima execucao), o ultimo backup do banco da Central e os alertas do Backup do Tiny. Use quando perguntarem se algo esta funcionando, ' +
        'ou quando outra ferramenta falhar e for preciso entender por que.',
      input_schema: { type: 'object', properties: {} },
    },
    async executar() {
      const s = sistemas();
      const temBackup = !!s.backup.baseUrl;
      const [aHealth, aMl, aTiny, acHealth, acStatus, nfHealth, nfTiny, nfMl, nfAgenda, ocHealth, ocChave, ocMl, ocFat, ocBackups, bkEstado] = await Promise.all([
        tentar(() => chamar('analytics', '/health')),
        tentar(() => chamar('analytics', '/api/oauth/ml/status')),
        tentar(() => chamar('analytics', '/api/tiny/status')),
        tentar(() => chamar('actions', '/health')),
        tentar(() => chamar('actions', '/api/status')),
        tentar(() => chamar('nf', '/health')),
        tentar(() => chamar('nf', '/api/oauth/status')),
        tentar(() => chamar('nf', '/api/oauth/ml/status')),
        tentar(() => chamar('nf', '/api/scheduler')),
        tentar(() => chamar('ocorrencias', '/healthz')),
        tentar(() => chamar('ocorrencias', '/api/admin/me')),
        tentar(() => chamar('ocorrencias', '/api/admin/ml/status')),
        tentar(() => chamar('ocorrencias', '/api/admin/ml/faturamento')),
        tentar(() => chamar('ocorrencias', '/api/admin/backups')),
        temBackup ? tentar(() => chamar('backup', '/painel/api/estado')) : Promise.resolve({ erro: 'Backup do Tiny nao ligado ao Gerente (falta BACKUP_BASE_URL).' }),
      ]);
      const ultimoBackupCentral = falhou(ocBackups) ? ocBackups : Array.isArray(ocBackups) && ocBackups[0] ? { nome: ocBackups[0].nome, criadoEm: ocBackups[0].criado, total: ocBackups.length } : { nenhum: true };
      return {
        [s.analytics.rotulo]: { health: aHealth, loginMercadoLivre: aMl, loginTiny: aTiny },
        [s.actions.rotulo]: { health: acHealth, status: acStatus },
        [s.nf.rotulo]: { health: nfHealth, loginTiny: nfTiny, loginMercadoLivre: nfMl, agendadorDeNotas: nfAgenda },
        [s.ocorrencias.rotulo]: {
          health: ocHealth, chaveDoGerente: ocChave,
          mercadoLivre: falhou(ocMl) ? ocMl : { configurado: ocMl?.configurado, conectado: ocMl?.conectado, conta: ocMl?.nickname, ultimaSync: ocMl?.ultimaSync, ultimoErro: ocMl?.ultimoErro },
          faturamentoMl: falhou(ocFat) ? ocFat : { lancamentos: ocFat?.lancamentos, pedidos: ocFat?.pedidos, ultimaSync: ocFat?.ultimaSync, ultimoErro: ocFat?.ultimoErro },
          ultimoBackupDoBanco: ultimoBackupCentral,
        },
        [s.backup.rotulo]: falhou(bkEstado) ? bkEstado : resumoDoBackup(bkEstado),
      };
    },
  },

  {
    sistema: 'geral',
    definicao: {
      name: 'panorama_da_operacao',
      description:
        'VISAO GERAL da operacao num unico passo, cruzando os quatro sistemas. Traz: vendas de hoje e de ontem ' +
        'comparadas com o mesmo dia da semana anterior (todos os canais, pelo Tiny); pedidos bloqueados e notas ' +
        'com erro; estoque rompido ou critico no ML; promocoes vencendo e anuncios que ficaram sem promocao; ' +
        'perguntas sem resposta no ML; ocorrencias abertas, sem responsavel e devolucoes aguardando acao; logins ' +
        'do ML e do Tiny (inclusive o ML da Central); alertas do Backup do Tiny. Cada bloco diz de qual sistema veio e se falhou. Use PRIMEIRO em "como estamos?", ' +
        '"o que preciso fazer hoje?", "resumo do dia" e depois aprofunde so no que pede atencao.',
      input_schema: { type: 'object', properties: {} },
    },
    async executar() {
      const hoje = dataEmBrasilia(0);
      const ontem = dataEmBrasilia(-1);
      const s = sistemas();
      const temOcorrencias = !!s.ocorrencias.baseUrl;
      const temBackup = !!s.backup.baseUrl;

      const [painel, vendasOntem, pendentes, reposicao, promocoes, perguntas, buyBox, ocorrencias, devolucoes, mlAnalytics, tinyAnalytics, tinyNf, mlNf, mlCentral, backup] =
        await Promise.all([
          tentar(() => chamar('nf', '/api/dashboard?dias=9')),
          tentar(() => chamar('nf', `/api/sales-report?data=${ontem}`)),
          tentar(() => chamar('nf', '/api/orders/pending')),
          tentar(() => ferramentaDoAnalytics('reposicao_de_estoque', { limite: 20 })),
          tentar(() => ferramentaDoAnalytics('promocoes_vencendo', { limite: 10 })),
          tentar(() => chamar('analytics', '/api/questions/pending')),
          tentar(() => ferramentaDoAnalytics('buy_box', { limite: 5 })),
          temOcorrencias ? tentar(() => chamar('ocorrencias', '/api/admin/ocorrencias')) : Promise.resolve({ erro: 'Central de Ocorrencias nao ligada ao Gerente.' }),
          temOcorrencias ? tentar(() => chamar('ocorrencias', '/api/admin/devolucoes')) : Promise.resolve({ erro: 'Central de Ocorrencias nao ligada ao Gerente.' }),
          tentar(() => chamar('analytics', '/api/oauth/ml/status')),
          tentar(() => chamar('analytics', '/api/tiny/status')),
          tentar(() => chamar('nf', '/api/oauth/status')),
          tentar(() => chamar('nf', '/api/oauth/ml/status')),
          temOcorrencias ? tentar(() => chamar('ocorrencias', '/api/admin/ml/status')) : Promise.resolve({ erro: 'Central de Ocorrencias nao ligada ao Gerente.' }),
          temBackup ? tentar(() => chamar('backup', '/painel/api/estado')) : Promise.resolve({ erro: 'Backup do Tiny nao ligado ao Gerente.' }),
        ]);

      const atencao: string[] = [];
      const bloco = (nome: string, r: unknown, monta: (r: any) => unknown) => (falhou(r) ? { sistema: nome, erro: r.erro } : { sistema: nome, ...(monta(r) as object) });

      // ---- vendas: hoje e ontem contra o mesmo dia da semana anterior (serie do painel)
      const vendas = bloco('tiny-pedidos-nf', painel, (p) => {
        const serie: any[] = Array.isArray(p?.serie) ? p.serie : [];
        const doDia = (d: string) => serie.find((x) => x.data === d);
        const semanaPassadaHoje = doDia(dataEmBrasilia(-7));
        const semanaPassadaOntem = doDia(dataEmBrasilia(-8));
        const h = p?.hoje ?? {};
        const o = falhou(vendasOntem) ? null : (vendasOntem as any)?.report ?? doDia(ontem);
        const vendaOntem = o?.vendaReal ?? null;
        const vHoje = variacao(h.vendaReal, semanaPassadaHoje?.vendaReal);
        const vOntem = variacao(vendaOntem, semanaPassadaOntem?.vendaReal);
        if (vOntem != null && vOntem <= -20) atencao.push(`Vendas de ontem ${vOntem}% abaixo do mesmo dia da semana passada.`);
        return {
          hoje: { data: hoje, pedidos: h.totalPedidos, vendaReal: h.vendaReal, porCanal: (h.canais ?? []).map((c: any) => ({ canal: c.canal, pedidos: c.pedidos, vendaReal: c.vendaReal })) },
          mesmoDiaSemanaPassada: semanaPassadaHoje ? { data: semanaPassadaHoje.data, pedidos: semanaPassadaHoje.pedidos, vendaReal: semanaPassadaHoje.vendaReal, variacaoPercentual: vHoje } : null,
          observacaoHoje: 'O dia ainda nao acabou: compare so com cautela.',
          ontem: { data: ontem, pedidos: o?.totalPedidos ?? o?.pedidos, vendaReal: vendaOntem, porCanal: (o?.canais ?? []).map((c: any) => ({ canal: c.canal, pedidos: c.pedidos, vendaReal: c.vendaReal })) },
          ontemContraSemanaPassada: semanaPassadaOntem ? { data: semanaPassadaOntem.data, vendaReal: semanaPassadaOntem.vendaReal, variacaoPercentual: vOntem } : null,
          participacaoPorCanal7d: p?.canais7d,
          topProdutos7d: (p?.topProdutos7d ?? []).slice(0, 5),
        };
      });

      // ---- pedidos e notas
      const pedidos = bloco('tiny-pedidos-nf', pendentes, (r) => {
        const todos: any[] = r?.orders ?? [];
        const bloqueados = todos.filter((o) => o.bloqueado);
        const prontos = todos.filter((o) => o.prontoParaNf && !o.jaProcessado);
        const venceHoje = todos.filter((o) => String(o.dataLimiteDespacho ?? o.dataPrevista ?? '').slice(0, 10) === hoje && !o.jaProcessado);
        const erros: any[] = falhou(painel) ? [] : (painel as any)?.operacao?.errosHoje ?? [];
        if (bloqueados.length) atencao.push(`${bloqueados.length} pedido(s) bloqueado(s) para nota.`);
        if (erros.length) atencao.push(`${erros.length} nota(s) com erro hoje.`);
        if (venceHoje.length) atencao.push(`${venceHoje.length} pedido(s) com despacho vencendo hoje ainda sem nota.`);
        return {
          retratoDe: r?.atualizadoEm,
          pendentes: todos.length,
          prontosParaNf: prontos.length,
          bloqueados: bloqueados.slice(0, 5).map((o) => ({ pedido: o.numeroPedido, canal: o.marketplace, motivo: o.motivoBloqueio })),
          totalBloqueados: bloqueados.length,
          despachoVenceHoje: venceHoje.slice(0, 5).map((o) => ({ pedido: o.numeroPedido, canal: o.marketplace })),
          totalDespachoVenceHoje: venceHoje.length,
          notasComErroHoje: erros.slice(0, 5),
          totalNotasComErroHoje: erros.length,
        };
      });

      // ---- estoque
      const estoque = bloco('ml-analytics', reposicao, (r) => {
        const itens: any[] = r?.itens ?? [];
        const rompidos = itens.filter((i) => i.urgencia === 'rompido');
        const criticos = itens.filter((i) => i.urgencia === 'critico');
        if (rompidos.length) atencao.push(`${rompidos.length} produto(s) com estoque rompido no ML.`);
        if (criticos.length) atencao.push(`${criticos.length} produto(s) com estoque critico no ML.`);
        return {
          disponivel: r?.disponivel,
          mensagem: r?.mensagem,
          resumo: r?.resumo,
          rompidos: rompidos.slice(0, 5).map((i) => ({ itemId: i.itemId, titulo: i.titulo, comprar: i.comprar })),
          criticos: criticos.slice(0, 5).map((i) => ({ itemId: i.itemId, titulo: i.titulo, estoque: i.estoque, diasAteRuptura: i.diasAteRuptura, comprar: i.comprar })),
          totalRompidos: rompidos.length,
          totalCriticos: criticos.length,
        };
      });

      // ---- Mercado Livre: promocoes, perguntas, buy box
      const mercadoLivre = {
        promocoes: bloco('ml-analytics', promocoes, (r) => {
          const t = r?.totais ?? {};
          if (t.anunciosVencendo) atencao.push(`${t.anunciosVencendo} anuncio(s) com promocao vencendo em breve.`);
          if (t.ficouSemPromocao) atencao.push(`${t.ficouSemPromocao} anuncio(s) ficaram sem promocao.`);
          return { disponivel: r?.disponivel, aviso: r?.aviso ?? r?.mensagem, totais: t, resumoEmTexto: r?.resumoEmTexto ?? null };
        }),
        perguntasSemResposta: bloco('ml-analytics', perguntas, (r) => {
          const lista: any[] = r?.questions ?? [];
          if (lista.length) atencao.push(`${lista.length} pergunta(s) sem resposta no Mercado Livre.`);
          return {
            total: r?.total ?? lista.length,
            atualizadoEm: r?.atualizadoEm,
            maisAntigas: [...lista].sort((a, b) => String(a.dateCreated).localeCompare(String(b.dateCreated))).slice(0, 3)
              .map((q) => ({ anuncio: q.itemTitle ?? q.itemId, desde: q.dateCreated, pergunta: String(q.text ?? '').slice(0, 160) })),
          };
        }),
        buyBox: bloco('ml-analytics', buyBox, (r) => {
          const n = r?.totalNoFiltro ?? 0;
          if (n) atencao.push(`${n} anuncio(s) de catalogo perdendo o Buy Box.`);
          return { perdendo: n, exemplos: (r?.itens ?? []).slice(0, 3), mensagem: r?.mensagem };
        }),
      };

      // ---- clientes: ocorrencias e devolucoes
      const clientes = {
        ocorrencias: bloco('Central de Ocorrencias', ocorrencias, (r) => {
          const contagem: Record<string, number> = r?.contagem ?? {};
          const abertas = Object.entries(contagem).filter(([k]) => k !== 'resolvida').reduce((t, [, n]) => t + Number(n), 0);
          const itens: any[] = (r?.itens ?? []).filter((i: any) => i.status !== 'resolvida');
          const semResponsavel = itens.filter((i) => !i.responsavel);
          const comPrazoHoje = itens.filter((i) => String(i.prazo_em ?? '').slice(0, 10) <= hoje && i.prazo_em);
          if (semResponsavel.length) atencao.push(`${semResponsavel.length} ocorrencia(s) aberta(s) sem responsavel (entre as 25 mais recentes).`);
          if (comPrazoHoje.length) atencao.push(`${comPrazoHoje.length} ocorrencia(s) com prazo do ML vencendo hoje ou vencido.`);
          return {
            abertas,
            porStatus: contagem,
            pendenciasComMlAguardando: r?.pendencias,
            semResponsavel: semResponsavel.slice(0, 5).map((i) => ({ protocolo: i.protocolo, assunto: r?.tipos?.[i.tipo] ?? i.tipo, abertaEm: i.criado_em })),
            prazoMlVencendo: comPrazoHoje.slice(0, 5).map((i) => ({ protocolo: i.protocolo, prazo: i.prazo_em, responsavel: i.responsavel })),
            observacao: 'Sem responsavel e prazo olham so as 25 ocorrencias mais recentes; use ocorrencias_lista para a lista completa.',
          };
        }),
        devolucoes: bloco('Central de Ocorrencias', devolucoes, (r) => {
          const c: Record<string, number> = r?.contagem ?? {};
          const pedemAcao = (c.aguardando_liberacao ?? 0) + (c.recebida ?? 0) + (c.nao_entregue ?? 0) + (c.em_contestacao ?? 0);
          if (pedemAcao) atencao.push(`${pedemAcao} devolucao(oes) pedindo acao (liberar, conferir, nao chegou ou em contestacao).`);
          return { pedemAcao, porEtapa: Object.fromEntries(Object.entries(c).map(([k, n]) => [r?.status?.[k] ?? k, n])) };
        }),
      };

      // ---- backup do Tiny: so os alertas da tela Saude dele
      const backupDoTiny = bloco('Backup do Tiny', backup, (r) => {
        const alertas: string[] = Array.isArray(r?.alertas) ? r.alertas : [];
        for (const a of alertas) atencao.push(`Backup do Tiny: ${a}`);
        return resumoDoBackup(r);
      });

      // ---- logins
      const login = (r: unknown, campo: string) => (falhou(r) ? { erro: r.erro } : { valido: !!(r as any)?.[campo] });
      const logins: Record<string, Record<string, { erro: string } | { valido: boolean }>> = {
        'ml-analytics': { mercadoLivre: login(mlAnalytics, 'authenticated'), tiny: login(tinyAnalytics, 'authenticated') },
        'tiny-pedidos-nf': { tiny: login(tinyNf, 'authenticated'), mercadoLivre: login(mlNf, 'authenticated') },
      };
      // Central: so conta se o ML estiver configurado la.
      if (!falhou(mlCentral) && (mlCentral as any)?.configurado !== false) logins['Central de Ocorrencias'] = { mercadoLivre: login(mlCentral, 'conectado') };
      for (const [sis, l] of Object.entries(logins)) {
        for (const [nome, v] of Object.entries(l)) {
          if ('valido' in v && v.valido === false) atencao.push(`Login do ${nome === 'tiny' ? 'Tiny' : 'Mercado Livre'} caiu no ${sis}.`);
        }
      }

      const sistemasComFalha = [painel, pendentes, reposicao, promocoes, perguntas, buyBox, ocorrencias, devolucoes, backup].filter(falhou).length;
      return {
        geradoEm: new Date().toISOString(),
        hoje,
        pontosDeAtencao: atencao.length ? atencao : ['Nada pedindo atencao nos dados disponiveis.'],
        blocosComFalha: sistemasComFalha || undefined,
        vendas,
        pedidosENotas: pedidos,
        estoque,
        mercadoLivre,
        clientes,
        backupDoTiny,
        logins,
      };
    },
  },

  // ---------------------------------------------------------------- ml-analytics (rotas que nao sao ferramentas la)
  {
    sistema: 'analytics',
    definicao: {
      name: 'ml_perguntas_sem_resposta',
      description:
        'Perguntas de compradores no Mercado Livre que ainda estao SEM RESPOSTA, com o anuncio, a data e o texto. ' +
        'Pergunta parada derruba a conversao do anuncio. Mais antigas primeiro. So leitura: o Gerente nao responde.',
      input_schema: { type: 'object', properties: { limite: { type: 'integer', description: '1 a 20, padrao 10' } } },
    },
    async executar(entrada) {
      const r = await chamar('analytics', '/api/questions/pending');
      const lista: any[] = [...(r?.questions ?? [])].sort((a, b) => String(a.dateCreated).localeCompare(String(b.dateCreated)));
      return {
        total: r?.total ?? lista.length,
        atualizadoEm: r?.atualizadoEm,
        itens: lista.slice(0, limitar(entrada?.limite, 10)).map((q) => ({
          anuncio: q.itemTitle ?? null, itemId: q.itemId, desde: q.dateCreated, pergunta: String(q.text ?? '').slice(0, 300), link: q.permalink,
        })),
      };
    },
  },
  {
    sistema: 'analytics',
    definicao: {
      name: 'ml_promocoes_aderidas',
      description:
        'Historico das adesoes a promocoes do Mercado Livre feitas pelos paineis do ml-analytics e do ml-actions (campo feitoPor): quando, anuncio, tipo e nome ' +
        'da promocao, preco final e se o ML aceitou ou recusou (com o erro). Mais recentes primeiro. Use para "o que ja ' +
        'aderimos?" ou "deu certo a adesao do MLB X?".',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['sucesso', 'erro'] },
          limite: { type: 'integer', description: '1 a 20, padrao 10' },
        },
      },
    },
    async executar(entrada) {
      const [r, ra] = await Promise.all([chamar('analytics', '/api/promocoes/adesoes'), tentar(() => chamar('actions', '/api/promocoes-historico'))]);
      const doActions: any[] = falhou(ra) ? [] : (ra?.items ?? []).map((i: any) => ({ ...i, feitoPor: 'ml-actions' }));
      let itens: any[] = [...(r?.items ?? []).map((i: any) => ({ ...i, feitoPor: 'ml-analytics' })), ...doActions].sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
      const porStatus = contarPor(itens, (i) => String(i.status));
      if (entrada?.status) itens = itens.filter((i) => i.status === entrada.status);
      return {
        escritaDePromocoesLigada: r?.escritaHabilitada,
        mlActions: falhou(ra) ? { erro: ra.erro } : { escritaDePromocoesLigada: ra?.escritaHabilitada },
        total: Object.values(porStatus).reduce((t, n) => t + n, 0),
        porStatus,
        // O corpo enviado ao ML e a resposta crua nao ajudam a responder; o erro em texto sim.
        itens: itens.slice(0, limitar(entrada?.limite, 10)).map((i) => ({
          quando: i.quando, feitoPor: i.feitoPor, itemId: i.itemId, titulo: i.titulo, tipo: i.tipo, promocao: i.nome ?? i.promocaoId,
          precoFinal: i.precoFinal, status: i.status, erro: i.erro ?? undefined,
        })),
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
        'reclamacoes abertas", "o que esta sem responsavel", "a fila da Bia", "ocorrencias do pedido X" ou "do cliente Y".',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['nova', 'em_analise', 'aguardando_cliente', 'resolvida', 'abertas'], description: '"abertas" = tudo que nao esta resolvido' },
          canal: { type: 'string', enum: ['mercado_livre', 'shopee', 'tiktok_shop', 'loja_propria'] },
          origem: { type: 'string', enum: ['ml', 'formulario'], description: 'ml = reclamacao aberta no Mercado Livre; formulario = cliente abriu pelo site' },
          pendencia: { type: 'string', enum: ['aguardando', 'creditou', 'negou', 'alguma'], description: 'pendencia de reembolso/credito com o Mercado Livre' },
          semResponsavel: { type: 'boolean', description: 'so as que ninguem da equipe assumiu' },
          responsavel: { type: 'string', description: 'nome (ou parte) de alguem da equipe: so a fila dessa pessoa' },
          busca: { type: 'string', description: 'protocolo, numero do pedido, nome do cliente ou rastreio da devolucao' },
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
      else if (typeof entrada?.responsavel === 'string' && entrada.responsavel.trim()) {
        const pessoa = await acharPessoa(entrada.responsavel);
        if ('erro' in pessoa) return pessoa;
        q.set('responsavel', String(pessoa.id));
      }
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
        properties: {
          protocolo: { type: 'string', description: 'protocolo da ocorrencia' },
          lancamentosMl: { type: 'boolean', description: 'true = traz tambem os lancamentos brutos do faturamento do ML ligados ao pedido (so ocorrencias do Mercado Livre)' },
        },
        required: ['protocolo'],
      },
    },
    async executar(entrada) {
      const protocolo = String(entrada?.protocolo || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,40}$/.test(protocolo)) return { erro: 'Informe o protocolo da ocorrencia (letras, numeros e hifen).' };
      const [o, bruto] = await Promise.all([
        chamar('ocorrencias', `/api/admin/ocorrencias/${protocolo}`),
        entrada?.lancamentosMl ? tentar(() => chamar('ocorrencias', `/api/admin/ocorrencias/${protocolo}/ml/financeiro-bruto`)) : Promise.resolve(undefined),
      ]);
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
        lancamentosMl: bruto === undefined ? undefined : falhou(bruto) ? { erro: bruto.erro } : resumirLancamentosMl(bruto),
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

  // ---------------------------------------------------------------- Central: equipe, fila e registro (v1.5)
  {
    sistema: 'ocorrencias',
    definicao: {
      name: 'ocorrencias_equipe',
      description:
        'Equipe da Central de Ocorrencias e a FILA de cada pessoa: quem e (nome, papel gerente/atendimento, ativo, ' +
        'ultimo login) e quantas ocorrencias abertas cada um tem, por status, mais as sem responsavel. Use para ' +
        '"como esta a carga da equipe?", "quem esta com mais casos?", "a Bia tem o que na fila?". Para ver os casos de ' +
        'uma pessoa, use ocorrencias_lista com responsavel.',
      input_schema: { type: 'object', properties: {} },
    },
    async executar() {
      const equipe: any[] = (await chamar('ocorrencias', '/api/admin/usuarios')) ?? [];
      const abertos = ['nova', 'em_analise', 'aguardando_cliente'];
      const contar = async (responsavel: string) => {
        const porStatus: Record<string, number> = {};
        await Promise.all(abertos.map(async (st) => {
          const r = await chamar('ocorrencias', `/api/admin/ocorrencias?status=${st}&responsavel=${responsavel}`);
          porStatus[st] = Number(r?.total ?? 0);
        }));
        return { total: Object.values(porStatus).reduce((t, n) => t + n, 0), porStatus };
      };
      const ativos = equipe.filter((u) => u.ativo !== 0 && u.ativo !== false);
      const [filas, semResponsavel] = await Promise.all([
        Promise.all(ativos.map(async (u) => ({ nome: u.nome, papel: u.papel, ultimoLogin: u.ultimo_login ?? null, fila: await tentar(() => contar(String(u.id))) }))),
        tentar(() => contar('nenhum')),
      ]);
      return {
        pessoasAtivas: ativos.length,
        inativas: equipe.length - ativos.length,
        semResponsavel,
        equipe: filas.sort((a, b) => (falhou(b.fila) ? 0 : b.fila.total) - (falhou(a.fila) ? 0 : a.fila.total)),
        observacao: 'Contagem de ocorrencias nao resolvidas por responsavel, direto da Central.',
      };
    },
  },
  {
    sistema: 'ocorrencias',
    definicao: {
      name: 'ocorrencias_registro',
      description:
        'Registro de atividades da Central de Ocorrencias (ultimas 100 linhas): quem fez o que e quando — logins, ' +
        'alertas, chaves, status mudado, mensagens ao ML, exportacoes. Use para "quem mexeu no caso X?", "a equipe ' +
        'entrou hoje?", "teve login estranho?". so=acessos traz apenas logins e alertas de seguranca.',
      input_schema: {
        type: 'object',
        properties: {
          so: { type: 'string', enum: ['acessos', 'tudo'], description: 'acessos = so logins e alertas (padrao: tudo)' },
          busca: { type: 'string', description: 'filtra pelo tipo, pessoa ou detalhe (ex.: protocolo)' },
          limite: { type: 'integer', description: '1 a 50, padrao 20' },
        },
      },
    },
    async executar(entrada) {
      const r: any[] = (await chamar('ocorrencias', `/api/admin/registro${entrada?.so === 'acessos' ? '?so=acessos' : ''}`)) ?? [];
      const busca = typeof entrada?.busca === 'string' ? entrada.busca.trim().toLowerCase() : '';
      const linhas = busca
        ? r.filter((l) => [l.tipo, l.quem, l.detalhe].some((v) => String(v ?? '').toLowerCase().includes(busca)))
        : r;
      return {
        lidas: r.length,
        noFiltro: linhas.length,
        porTipo: contarPor(linhas, (l: any) => String(l.tipo)),
        // IP e e-mail ficam na Central: a conversa precisa de quem, o que e quando.
        linhas: linhas.slice(0, limitar(entrada?.limite, 20, 50)).map((l) => ({ em: l.criado_em, tipo: l.tipo, quem: l.quem, detalhe: l.detalhe ? String(l.detalhe).slice(0, 200) : undefined })),
      };
    },
  },

  // ---------------------------------------------------------------- tiny-pedidos-nf: pedido por numero (v1.5)
  {
    sistema: 'nf',
    definicao: {
      name: 'nf_buscar_pedido',
      description:
        'Acha um pedido no Tiny pelo NUMERO DO PEDIDO NO CANAL (numero do Mercado Livre, Shopee ou TikTok), em qualquer ' +
        'situacao e data: situacao, canal, data, cliente, valor e se ja tem nota fiscal. Use para "cade o pedido X?", ' +
        '"o pedido X ja tem nota?". Para o pedido interno do Tiny e o desconto, use nf_previa_pedido.',
      input_schema: {
        type: 'object',
        properties: { numero: { type: 'string', description: 'numero do pedido no canal de venda' } },
        required: ['numero'],
      },
    },
    async executar(entrada) {
      const numero = String(entrada?.numero ?? '').trim();
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(numero)) return { erro: 'Informe o numero do pedido no canal (letras, numeros, hifen).' };
      const r = await chamar('nf', `/api/debug/tiny-find/${encodeURIComponent(numero)}`);
      const situacoes: Record<number, string> = { 0: 'aberto', 1: 'aprovado', 2: 'cancelado', 3: 'enviado', 4: 'entregue', 5: 'pronto para envio', 6: 'em separacao', 7: 'pronto para envio', 8: 'faturado', 9: 'dados incompletos' };
      const itens: any[] = r?.itens ?? [];
      return {
        encontrados: r?.total ?? itens.length,
        pedidos: itens.slice(0, 5).map((p) => ({
          idTiny: p.id, numeroTiny: p.numeroPedido, numeroNoCanal: p.ecommerce?.numeroPedidoEcommerce ?? numero,
          canal: p.ecommerce?.nome ?? p.ecommerce?.canalVenda ?? undefined,
          situacao: typeof p.situacao === 'number' ? (situacoes[p.situacao] ?? `codigo ${p.situacao}`) : p.situacao,
          criadoEm: p.dataCriacao, dataPrevista: p.dataPrevista, cliente: p.cliente?.nome, valor: p.valor, temNotaFiscal: !!p.idNotaFiscal,
        })),
        observacao: 'A situacao vem do codigo do Tiny; se o nome parecer estranho, confira pelo painel.',
      };
    },
  },

  // ---------------------------------------------------------------- Backup do Tiny (v1.5)
  {
    sistema: 'backup',
    definicao: {
      name: 'backup_tiny_estado',
      description:
        'Estado do BACKUP DO TINY (mcs-backup-tiny): se esta sem alerta, os alertas da tela Saude (batimento, disco, token ' +
        'do Tiny, limite de chamadas), janela de coleta, o que rodou nas ultimas 24 h, fila, os ultimos meses (notas no Tiny ' +
        'e no backup, coleta, verificacao, Google Drive, selo de seguro para exclusao), exclusoes em andamento, robo de exclusao ' +
        'e envios ao Drive. Use para "o backup esta em dia?", "o mes passado ja foi conferido?", "pode excluir do Tiny?".',
      input_schema: { type: 'object', properties: { meses: { type: 'integer', description: 'quantos meses recentes listar (1 a 6, padrao 3)' } } },
    },
    async executar(entrada) {
      const r = await chamar('backup', '/painel/api/estado');
      const resumo = resumoDoBackup(r);
      const n = limitar(entrada?.meses, 3, 6);
      return {
        ...resumo,
        mesesRecentes: (Array.isArray(r?.meses) ? r.meses : []).slice(0, n).map((m: any) => ({
          mes: m.mes, notasNoTiny: m.notasNoTiny, notasNoBackup: m.notasNoBackup, coleta: m.coleta, coletaEm: m.coletaEm,
          verificacao: m.verificacao, verificadaEm: m.verificadaEm, vps: m.vps, drive: m.drive, temCopiaExterna: m.temCopiaExterna, selo: m.selo, exclusao: m.exclusao,
        })),
        resumo24h: r?.ultimas24h?.resumo,
        fila: r?.fila,
        exclusoes: r?.exclusoes,
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
  const semBackup = !sistemas().backup.baseUrl;
  if (semBackup) {
    avisos.push('O Backup do Tiny nao esta ligado ao Gerente (falta BACKUP_BASE_URL). Perguntas sobre o backup nao podem ser respondidas por aqui.');
  }
  const locais = FERRAMENTAS_LOCAIS.filter((f) => !(semOcorrencias && f.sistema === 'ocorrencias') && !(semBackup && f.sistema === 'backup'));
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
