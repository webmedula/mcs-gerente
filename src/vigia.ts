import { FastifyInstance } from 'fastify';
import { config } from './config';
import { logger } from './logger';
import { chamar, NomeSistema, sistemas } from './sistemas';
import { enviar } from './routes/telegram';

/**
 * VIGIA DE LOGINS (v1.4).
 *
 * Os logins do Mercado Livre e do Tiny ficam em arquivo dentro de cada servico, e caem sem
 * ninguem saber: so se descobre quando alguem pergunta algo ao Gerente e a resposta vem pela
 * metade. O vigia confere todos a cada VIGIA_MINUTOS e manda uma mensagem no Telegram SO quando
 * algo muda (caiu, voltou, servico fora do ar). Nao passa pela IA: texto pronto, sem custo.
 *
 * v1.5: entram a Central de Ocorrencias (Central v1.12.0 abriu /ml/status pra chave da IA; so conta se o
 * ML estiver configurado la) e o Backup do Tiny (alvo de SAUDE: avisa quando a tela Saude dele ganha
 * alerta, com o texto do alerta, e quando limpa).
 */

export type Estado = 'ok' | 'caido' | 'fora';

export interface Alvo {
  id: string;
  rotulo: string;
  sistema: NomeSistema;
  caminho: string;
  /** Campo booleano da resposta que diz se o login vale (ou, num alvo de saude, se esta sem alerta). */
  campo: string;
  /** 'login' (padrao) ou 'saude': muda o texto do aviso. */
  tipo?: 'login' | 'saude';
  /** Campo booleano que, quando vier false, tira o alvo da leitura (ex.: ML nao configurado na Central). */
  ignorarSe?: string;
}

export const ALVOS: Alvo[] = [
  { id: 'analytics.ml', rotulo: 'Mercado Livre no ml-analytics', sistema: 'analytics', caminho: '/api/oauth/ml/status', campo: 'authenticated' },
  { id: 'analytics.tiny', rotulo: 'Tiny no ml-analytics', sistema: 'analytics', caminho: '/api/tiny/status', campo: 'authenticated' },
  { id: 'nf.tiny', rotulo: 'Tiny no tiny-pedidos-nf', sistema: 'nf', caminho: '/api/oauth/status', campo: 'authenticated' },
  { id: 'nf.ml', rotulo: 'Mercado Livre no tiny-pedidos-nf', sistema: 'nf', caminho: '/api/oauth/ml/status', campo: 'authenticated' },
  { id: 'actions.ml', rotulo: 'Mercado Livre no ml-actions', sistema: 'actions', caminho: '/api/oauth/ml/status', campo: 'authenticated' },
  { id: 'ocorrencias.ml', rotulo: 'Mercado Livre na Central de Ocorrencias', sistema: 'ocorrencias', caminho: '/api/admin/ml/status', campo: 'conectado', ignorarSe: 'configurado' },
  { id: 'backup.saude', rotulo: 'Backup do Tiny', sistema: 'backup', caminho: '/painel/api/estado', campo: 'ok', tipo: 'saude' },
];

export interface Leitura {
  id: string;
  rotulo: string;
  estado: Estado;
  detalhe?: string;
  tipo?: 'login' | 'saude';
}

/** Le o estado de todos os alvos agora. Servico sem URL configurada fica de fora. */
export async function verificar(): Promise<Leitura[]> {
  const s = sistemas();
  const ativos = ALVOS.filter((a) => s[a.sistema].baseUrl);
  const leituras = await Promise.all(
    ativos.map(async (a): Promise<Leitura | null> => {
      try {
        const r = await chamar(a.sistema, a.caminho, { timeoutMs: 15000 });
        if (a.ignorarSe && r?.[a.ignorarSe] === false) return null;
        const ok = r?.[a.campo] === true;
        const detalhe = !ok && a.tipo === 'saude' && Array.isArray(r?.alertas) ? r.alertas.join(' ') : undefined;
        return { id: a.id, rotulo: a.rotulo, estado: ok ? 'ok' : 'caido', detalhe, tipo: a.tipo };
      } catch (err: any) {
        return { id: a.id, rotulo: a.rotulo, estado: 'fora', detalhe: err?.message || String(err), tipo: a.tipo };
      }
    }),
  );
  return leituras.filter((l): l is Leitura => l !== null);
}

interface Memoria {
  estado: Estado;
  /** Quantas leituras seguidas deram este estado. */
  vezes: number;
  /** Se a queda (caido/fora) ja foi avisada. "Voltou" so sai depois de um aviso de queda. */
  avisado: boolean;
}

/**
 * Compara a leitura nova com a anterior e devolve as linhas a avisar. Funcao pura, pra testar.
 *
 * - Primeira leitura (sem anterior): avisa so o que ja esta caido/fora. Depois de um deploy do
 *   Gerente isso repete o aviso de quem continua caido, o que e util, nao ruido.
 * - "caiu" e "voltou" avisam na hora.
 * - "fora do ar" so avisa na SEGUNDA leitura seguida: um timeout isolado nao vira mensagem.
 * - "voltou" so sai se a queda tiver sido avisada: timeout isolado seguido de ok fica em silencio.
 */
export function compararEstados(anterior: Map<string, Memoria>, leituras: Leitura[]): { avisos: string[]; memoria: Map<string, Memoria> } {
  const memoria = new Map<string, Memoria>();
  const avisos: string[] = [];
  for (const l of leituras) {
    const antes = anterior.get(l.id);
    const mesmo = !!antes && antes.estado === l.estado;
    const vezes = mesmo ? antes!.vezes + 1 : 1;
    let avisado = mesmo ? antes!.avisado : false;

    if (l.estado === 'fora') {
      // Primeira leitura do vigia ja fora: avisa. Mudou pra fora: so quando a segunda leitura confirma.
      if (!antes || (vezes === 2 && !avisado)) {
        avisos.push(`⚠️ ${l.rotulo}: servico fora do ar ou sem responder (${l.detalhe ?? 'sem detalhe'}).`);
        avisado = true;
      }
    } else if (l.estado === 'caido') {
      if (!mesmo) {
        avisos.push(l.tipo === 'saude'
          ? `🔴 ${l.rotulo}: com ALERTA na tela Saude${l.detalhe ? ` (${l.detalhe})` : ''}.`
          : `🔴 ${l.rotulo}: login CAIU. Refaca o login no painel desse sistema.`);
        avisado = true;
      }
    } else if (antes && antes.estado !== 'ok' && antes.avisado) {
      avisos.push(l.tipo === 'saude' ? `🟢 ${l.rotulo}: sem alerta de novo.` : `🟢 ${l.rotulo}: voltou.`);
    }
    memoria.set(l.id, { estado: l.estado, vezes, avisado });
  }
  return { avisos, memoria };
}

let memoria = new Map<string, Memoria>();
let ultimaLeitura: { em: string; leituras: Leitura[] } | null = null;

export async function rodarVigia(): Promise<{ leituras: Leitura[]; avisos: string[] }> {
  const leituras = await verificar();
  const r = compararEstados(memoria, leituras);
  memoria = r.memoria;
  ultimaLeitura = { em: new Date().toISOString(), leituras };
  if (r.avisos.length) {
    const texto = `👁️ Vigia de logins\n\n${r.avisos.join('\n')}`;
    for (const chatId of config.telegramChatIds) await enviar(chatId, texto);
    logger.info(`[VIGIA] ${r.avisos.length} aviso(s) enviado(s).`);
  }
  return { leituras, avisos: r.avisos };
}

export function startVigia(): void {
  if (config.vigiaMinutos <= 0) {
    logger.info('[VIGIA] Desligado (VIGIA_MINUTOS=0).');
    return;
  }
  if (!config.telegramBotToken || config.telegramChatIds.length === 0) {
    logger.info('[VIGIA] Sem destino (falta TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_IDS).');
    return;
  }
  const rodar = () => rodarVigia().catch((err) => logger.warn('[VIGIA] Falha:', err?.message || err));
  // Primeira leitura logo depois de subir, com folga pros outros servicos subirem junto num deploy.
  setTimeout(rodar, 60 * 1000).unref();
  setInterval(rodar, config.vigiaMinutos * 60 * 1000).unref();
  logger.info(`[VIGIA] Ligado: confere os logins a cada ${config.vigiaMinutos} min.`);
}

/** So pra testes. */
export function _zerarVigia(): void {
  memoria = new Map();
  ultimaLeitura = null;
}

/** /debug/vigia: le agora e mostra o estado; com ?enviar=1 manda o resumo atual pros chats. */
export async function vigiaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/vigia', async (req) => {
    const r = await rodarVigia();
    const mandar = (req.query as { enviar?: string } | undefined)?.enviar === '1';
    const resumo = r.leituras.map((l) => `${l.estado === 'ok' ? '🟢' : l.estado === 'caido' ? '🔴' : '⚠️'} ${l.rotulo}: ${l.estado}`).join('\n');
    if (mandar) for (const chatId of config.telegramChatIds) await enviar(chatId, `👁️ Vigia de logins (pedido manual)\n\n${resumo}`);
    return { ligado: config.vigiaMinutos > 0, aCadaMinutos: config.vigiaMinutos, lidoEm: ultimaLeitura?.em, leituras: r.leituras, avisosEnviadosAgora: r.avisos, enviadoResumo: mandar };
  });
}
