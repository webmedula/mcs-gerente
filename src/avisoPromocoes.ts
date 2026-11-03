import { FastifyInstance } from 'fastify';
import { config } from './config';
import { logger } from './logger';
import { chamar } from './sistemas';
import { enviar } from './routes/telegram';

/**
 * AVISO DIARIO DE PROMOCOES DO ML (v1.2).
 *
 * Uma vez por dia, na hora configurada (horario de Brasilia), pergunta ao ml-analytics quais
 * propostas de promocao do Mercado Livre apareceram nas ultimas 24h e manda pros chats liberados.
 *
 * Nao passa pela IA: o texto vem pronto do analytics (resumoEmTexto), entao nao custa token e nao
 * tem numero reescrito pelo modelo. Sem proposta nova, nao manda nada — aviso que chega todo dia
 * dizendo "nada" vira ruido e para de ser lido.
 *
 * Usa a mesma trava de leitura do resto do Gerente (POST so na rota de ferramentas do analytics).
 */

/** Hora (0-23) e data (YYYY-MM-DD) no fuso de Brasilia. Pura, pra testar sem relogio. */
export function horaEmBrasilia(agora: Date): { hora: number; dia: string } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value]),
  );
  return { hora: Number(partes.hour), dia: `${partes.year}-${partes.month}-${partes.day}` };
}

/** Manda hoje? So na hora marcada e uma vez por dia. */
export function deveAvisar(agora: Date, horaMarcada: number, ultimoDiaEnviado: string | null): boolean {
  const { hora, dia } = horaEmBrasilia(agora);
  return hora === horaMarcada && dia !== ultimoDiaEnviado;
}

/** Busca as propostas novas e devolve o texto, ou null quando nao ha nada novo. */
export async function montarAviso(): Promise<{ texto: string | null; detalhe: unknown }> {
  const r = await chamar('analytics', '/api/assistente/ferramenta/promocoes_do_ml', {
    metodo: 'POST',
    corpo: { entrada: { apenas_novas: true, horas: 24, limite: 10 } },
  });
  const saida = r?.saida ?? {};
  if (saida.disponivel === false || saida.erro) return { texto: null, detalhe: saida };
  return { texto: saida.resumoEmTexto ? `🏷️ Promoções novas do Mercado Livre\n\n${saida.resumoEmTexto}` : null, detalhe: { total: saida.total } };
}

let ultimoDiaEnviado: string | null = null;

async function rodar(agora = new Date()): Promise<void> {
  if (!deveAvisar(agora, config.avisoPromocoesHora, ultimoDiaEnviado)) return;
  ultimoDiaEnviado = horaEmBrasilia(agora).dia;
  try {
    const { texto, detalhe } = await montarAviso();
    if (!texto) {
      logger.info('[PROMOCOES] Sem proposta nova hoje (ou analytics indisponivel):', JSON.stringify(detalhe));
      return;
    }
    for (const chatId of config.telegramChatIds) await enviar(chatId, texto);
    logger.info(`[PROMOCOES] Aviso enviado para ${config.telegramChatIds.length} chat(s).`);
  } catch (err: any) {
    logger.warn('[PROMOCOES] Falha no aviso diario:', err?.message || err);
  }
}

export function startAvisoPromocoes(): void {
  if (config.avisoPromocoesHora < 0) {
    logger.info('[PROMOCOES] Aviso diario desligado (AVISO_PROMOCOES_HORA=-1).');
    return;
  }
  if (!config.telegramBotToken || config.telegramChatIds.length === 0) {
    logger.info('[PROMOCOES] Aviso diario sem destino (falta TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_IDS).');
    return;
  }
  setInterval(() => void rodar(), 5 * 60 * 1000).unref();
  logger.info(`[PROMOCOES] Aviso diario de promocoes ligado (${config.avisoPromocoesHora}h, horario de Brasilia).`);
}

/** /debug/aviso-promocoes mostra o texto de hoje; com ?enviar=1 manda agora pros chats liberados. */
export async function avisoPromocoesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/aviso-promocoes', async (req) => {
    const { texto, detalhe } = await montarAviso();
    const mandar = (req.query as { enviar?: string } | undefined)?.enviar === '1';
    if (mandar && texto) for (const chatId of config.telegramChatIds) await enviar(chatId, texto);
    return { texto, detalhe, enviado: mandar && !!texto };
  });
}
