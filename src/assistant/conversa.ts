import { config } from '../config';
import { logger } from '../logger';
import { catalogo, executarFerramenta } from './ferramentas';
import { provedorAtivo } from './provedores';

/**
 * Conduz a conversa com o modelo usando FERRAMENTAS, seja qual for o provedor.
 * Veio do ml-analytics v33 (claudeClient.ts); a mudanca e que agora as ferramentas cobrem os tres
 * sistemas e a lista e montada a cada pergunta (parte dela vem do ml-analytics).
 */

const REGRAS = `Voce e o Gerente da MCS: o assistente da operacao de um vendedor de marketplace (Mercado Livre,
Shopee e TikTok), integrado ao ERP Tiny. Voce consulta TRES sistemas:

- ml-analytics: analises do Mercado Livre — faturamento, liquido, margem, conversao, Buy Box, notas dos
  anuncios, reposicao de estoque e uma base SQL com o historico de vendas do ML.
- ml-actions: recriacao de anuncios no Mercado Livre — fila de candidatos, historico do que ja foi
  recriado e diagnostico de por que uma recriacao falha. (ferramentas recriacao_*)
- tiny-pedidos-nf: pedidos em aberto no Tiny de todos os canais, aplicacao do desconto da lista de preco e
  emissao de nota fiscal — pendentes, processados, erros, lotes e vendas por dia. (ferramentas nf_*)

REGRAS:
- Todo numero que voce disser tem que ter vindo de uma ferramenta. Nunca estime, arredonde por conta
  propria nem complete o que faltou. Se a ferramenta nao trouxe o dado, diga que nao tem.
- "Liquido" = venda menos comissao do ML menos frete pago pelo vendedor. "Margem" = liquido menos o
  custo do produto. Sao coisas diferentes; nao troque uma pela outra.
- Margem so existe para anuncios com custo cadastrado no Tiny. Quando faltar, diga que falta e por
  que (a ferramenta informa), em vez de omitir o anuncio em silencio.
- Vendas de TODOS os canais (Shopee, TikTok, ML juntos) vem do tiny-pedidos-nf (nf_vendas_do_dia, nf_painel).
  Analise detalhada do Mercado Livre vem do ml-analytics. Diga de qual sistema veio o numero quando
  misturar os dois, porque os criterios nao sao identicos.
- Se uma ferramenta devolver erro, diga qual sistema falhou em vez de responder sem o dado.
- Ao comparar ou recomendar, diga em que numero voce se baseou.
- Responda em portugues do Brasil, direto, no tom de quem conversa com o dono da loja. Voce esta no
  Telegram: seja curto. Valores em R$ com duas casas. No maximo uns 6 itens por lista.
- Nao use tabela nem markdown pesado: o Telegram nao renderiza bem. Listas com hifen funcionam.
- Voce so LE dados (versao 1). Nao recria anuncio, nao emite nota, nao altera preco, pedido nem estoque.
  Se pedirem, explique que essa acao ainda precisa ser feita pelo painel do sistema correspondente.`;

function sistema(avisos: string[]): string {
  // O modelo nao sabe que dia e hoje, e "vendas de ontem" depende disso. Fuso da operacao.
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const partes = [REGRAS, `\nHoje e ${hoje} (horario de Brasilia). Use datas YYYY-MM-DD nas ferramentas.`];
  if (avisos.length) partes.push(`\nAVISOS DO MOMENTO:\n- ${avisos.join('\n- ')}`);
  return partes.join('\n');
}

export async function listarModelos(): Promise<Array<{ id: string; detalhe?: string }>> {
  return provedorAtivo().listarModelos();
}

export async function resolverModelo(forcar = false): Promise<string> {
  return provedorAtivo().resolverModelo(forcar);
}

export interface RespostaDoAssistente {
  texto: string;
  ferramentasUsadas: string[];
  passos: number;
  provedor: string;
  modelo: string;
}

/** Roda a conversa ate o modelo parar de pedir ferramenta, com teto de passos. */
export async function perguntar(pergunta: string): Promise<RespostaDoAssistente> {
  const provedor = provedorAtivo();
  if (!provedor.configurado()) {
    throw new Error(`Provedor "${provedor.nome}" sem chave configurada. Veja /debug/assistente.`);
  }

  const [modelo, cat] = await Promise.all([provedor.resolverModelo(), catalogo()]);
  const instrucoes = sistema(cat.avisos);
  const mensagens: any[] = [provedor.mensagemDoUsuario(pergunta)];
  const usadas: string[] = [];

  for (let passo = 1; passo <= config.assistenteMaxPassos; passo++) {
    const r = await provedor.conversar(mensagens, modelo, instrucoes, cat.ferramentas);

    if (r.chamadas.length === 0) {
      return {
        texto: r.texto || 'Nao consegui formular uma resposta.',
        ferramentasUsadas: usadas,
        passos: passo,
        provedor: provedor.nome,
        modelo,
      };
    }

    mensagens.push(r.mensagemDoAssistente);

    // Chamadas do mesmo passo sao independentes e em sistemas diferentes: roda em paralelo.
    const resultados = await Promise.all(
      r.chamadas.map(async (chamada) => {
        usadas.push(chamada.nome);
        let saida: unknown;
        try {
          saida = await executarFerramenta(chamada.nome, chamada.entrada);
        } catch (err: any) {
          // Erro vira resultado, nao excecao: o modelo explica a falha ao usuario.
          saida = { erro: err?.message || String(err) };
        }
        return { chamada, saida };
      }),
    );

    mensagens.push(...provedor.mensagensDeResultado(resultados));
  }

  logger.warn(`[ASSISTENTE] Teto de ${config.assistenteMaxPassos} passos atingido: "${pergunta.slice(0, 60)}"`);
  return {
    texto: 'A consulta ficou longa demais e eu parei no meio. Tenta perguntar de forma mais especifica.',
    ferramentasUsadas: usadas,
    passos: config.assistenteMaxPassos,
    provedor: provedor.nome,
    modelo,
  };
}
