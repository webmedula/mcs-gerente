import { FastifyInstance } from 'fastify';
import { config } from './config';
import { logger } from './logger';
import { chamar } from './sistemas';
import { enviar } from './routes/telegram';
import { horaEmBrasilia } from './avisoPromocoes';

/**
 * RADAR DE MERCADO DO ML (v1.8.0).
 *
 * Toda semana (padrao: segunda, 9h de Brasilia) pede ao ml-analytics o radar (ferramenta mercado_radar):
 * a foto das categorias da MCS desta semana comparada com a anterior — nossos produtos na lista de mais
 * vendidos, quem entrou, quem subiu e as buscas em alta. O analytics tira a foto na segunda a partir das 6h.
 *
 * Sem IA (texto pronto do analytics, sem custo de token). Mesma trava de leitura do resto do Gerente.
 */

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Dia da semana (0 = domingo) em Brasilia. Pura. */
export function diaDaSemanaEmBrasilia(agora: Date): number {
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(agora);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nome);
}

/** Manda agora? So no dia e na hora marcados, uma vez por dia. */
export function deveMandarRadar(agora: Date, diaMarcado: number, horaMarcada: number, ultimoDiaEnviado: string | null): boolean {
  const { hora, dia } = horaEmBrasilia(agora);
  return diaDaSemanaEmBrasilia(agora) === diaMarcado && hora === horaMarcada && dia !== ultimoDiaEnviado;
}

export async function montarRadar(): Promise<{ texto: string | null; detalhe: unknown }> {
  const r = await chamar('analytics', '/api/assistente/ferramenta/mercado_radar', { metodo: 'POST', corpo: { entrada: {} } });
  const saida = r?.saida ?? {};
  if (saida.disponivel === false || saida.erro || !saida.resumoEmTexto) return { texto: null, detalhe: saida };
  return {
    texto: `📊 Radar de mercado do Mercado Livre\n\n${saida.resumoEmTexto}\n\nPergunte "quais os mais vendidos de <categoria>?" ou "quem vende <produto> e por quanto?" para ver mais.`,
    detalhe: { fotoAtual: saida.fotoAtual, fotoAnterior: saida.fotoAnterior },
  };
}

let ultimoDiaEnviado: string | null = null;

async function rodar(agora = new Date()): Promise<void> {
  if (!deveMandarRadar(agora, config.radarMercadoDia, config.radarMercadoHora, ultimoDiaEnviado)) return;
  ultimoDiaEnviado = horaEmBrasilia(agora).dia;
  try {
    const { texto, detalhe } = await montarRadar();
    if (!texto) {
      logger.info('[RADAR] Sem radar para mandar (analytics sem foto ou indisponivel):', JSON.stringify(detalhe));
      return;
    }
    for (const chatId of config.telegramChatIds) await enviar(chatId, texto);
    logger.info(`[RADAR] Radar de mercado enviado para ${config.telegramChatIds.length} chat(s).`);
  } catch (err: any) {
    logger.warn('[RADAR] Falha no radar de mercado:', err?.message || err);
  }
}

export function startRadarMercado(): void {
  if (config.radarMercadoHora < 0 || config.radarMercadoDia < 0 || config.radarMercadoDia > 6) {
    logger.info('[RADAR] Radar de mercado desligado (RADAR_MERCADO_HORA=-1 ou dia invalido).');
    return;
  }
  if (!config.telegramBotToken || config.telegramChatIds.length === 0) {
    logger.info('[RADAR] Radar de mercado sem destino (falta TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_IDS).');
    return;
  }
  setInterval(() => void rodar(), 5 * 60 * 1000).unref();
  logger.info(`[RADAR] Radar de mercado ligado (${DIAS[config.radarMercadoDia]}, ${config.radarMercadoHora}h, horário de Brasília).`);
}

/** /debug/radar-mercado mostra o texto; com ?enviar=1 manda agora pros chats liberados. */
export async function radarMercadoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/radar-mercado', async (req) => {
    const { texto, detalhe } = await montarRadar();
    const mandar = (req.query as { enviar?: string } | undefined)?.enviar === '1';
    if (mandar && texto) for (const chatId of config.telegramChatIds) await enviar(chatId, texto);
    return { texto, detalhe, enviado: mandar && !!texto };
  });
}
