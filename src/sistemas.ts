import { config } from './config';

/**
 * CLIENTE DOS CINCO SISTEMAS DA MCS.
 *
 * v1 e SOMENTE LEITURA, e isso nao depende do modelo "se comportar": a trava esta aqui.
 * - GET em qualquer rota /api/ ou /health.
 * - POST so na rota de ferramentas do ml-analytics, que executa funcoes de leitura (o POST
 *   existe porque a entrada pode ser um SQL longo).
 * Qualquer outra combinacao e recusada ANTES de sair da maquina. Quando a fase 2 (acoes com
 * confirmacao) chegar, ela entra por uma lista explicita de rotas de escrita, nao afrouxando isto.
 *
 * Central de Ocorrencias (mcs-ocorrencias): alem da trava geral, so passam os GET da lista
 * GET_PERMITIDO abaixo. La tem rotas GET que baixam backup, CSV com dados pessoais e anexos; a
 * Central ja recusa a chave da IA nelas, mas aqui elas nem saem do Gerente.
 *
 * Backup do Tiny (mcs-backup-tiny): so a rota de estado em JSON e o 'ok' de saude. O painel dele e
 * por login de pessoa; a chave PANEL_API_KEY nao abre mais nada la.
 */

export type NomeSistema = 'analytics' | 'actions' | 'nf' | 'ocorrencias' | 'backup';

export interface Sistema {
  nome: NomeSistema;
  rotulo: string;
  baseUrl: string;
  apiKey: string;
  /** Como a chave vai no cabecalho. A Central usa Bearer (chave mcsia_ criada no painel dela). */
  autenticacao: 'x-api-key' | 'bearer';
  /** Rota aberta de saude (a Central usa /healthz). */
  rotaSaude: string;
  /** Cabecalhos a mais em toda chamada (v1.5.1: a senha do painel de vendas do nf). */
  cabecalhosExtras?: Record<string, string>;
}

export function sistemas(): Record<NomeSistema, Sistema> {
  return {
    analytics: { nome: 'analytics', rotulo: 'ml-analytics', baseUrl: config.analyticsBaseUrl, apiKey: config.analyticsApiKey, autenticacao: 'x-api-key', rotaSaude: '/health' },
    actions: { nome: 'actions', rotulo: 'ml-actions', baseUrl: config.actionsBaseUrl, apiKey: config.actionsApiKey, autenticacao: 'x-api-key', rotaSaude: '/health' },
    nf: {
      nome: 'nf', rotulo: 'tiny-pedidos-nf', baseUrl: config.nfBaseUrl, apiKey: config.nfApiKey, autenticacao: 'x-api-key', rotaSaude: '/health',
      cabecalhosExtras: config.nfDashboardKey ? { 'x-dashboard-key': config.nfDashboardKey } : undefined,
    },
    ocorrencias: { nome: 'ocorrencias', rotulo: 'Central de Ocorrencias', baseUrl: config.ocorrenciasBaseUrl, apiKey: config.ocorrenciasApiKey, autenticacao: 'bearer', rotaSaude: '/healthz' },
    backup: { nome: 'backup', rotulo: 'Backup do Tiny', baseUrl: config.backupBaseUrl, apiKey: config.backupApiKey, autenticacao: 'x-api-key', rotaSaude: '/painel/saude' },
  };
}

/** Cabecalho com a chave, no formato que cada sistema espera. */
export function cabecalhoDaChave(s: Sistema): Record<string, string> {
  const extras = s.cabecalhosExtras ?? {};
  if (!s.apiKey) return { ...extras };
  return { ...extras, ...(s.autenticacao === 'bearer' ? { authorization: `Bearer ${s.apiKey}` } : { 'x-api-key': s.apiKey }) };
}

const POST_PERMITIDO: Record<NomeSistema, RegExp[]> = {
  analytics: [/^\/api\/assistente\/ferramenta\/[a-z0-9_]+$/],
  actions: [],
  nf: [],
  ocorrencias: [],
  backup: [],
};

/** Sistemas com lista fechada de GET. Quem nao esta aqui aceita qualquer GET em /api/. */
const PROTOCOLO = '[A-Za-z0-9-]{4,40}';
const GET_PERMITIDO: Partial<Record<NomeSistema, RegExp[]>> = {
  ocorrencias: [
    /^\/healthz$/,
    /^\/api\/admin\/me$/,
    /^\/api\/admin\/ocorrencias$/,
    new RegExp(`^/api/admin/ocorrencias/${PROTOCOLO}$`),
    /^\/api\/admin\/devolucoes$/,
    /^\/api\/admin\/estatisticas$/,
    /^\/api\/admin\/modelos$/,
    // v1.5 (Central v1.12.0): leitura que antes era so do gerente humano. Downloads de backup continuam fora.
    new RegExp(`^/api/admin/ocorrencias/${PROTOCOLO}/devolucao$`),
    new RegExp(`^/api/admin/ocorrencias/${PROTOCOLO}/ml/financeiro-bruto$`),
    /^\/api\/admin\/usuarios$/,
    /^\/api\/admin\/ml\/status$/,
    /^\/api\/admin\/ml\/faturamento$/,
    /^\/api\/admin\/backups$/,
    /^\/api\/admin\/registro$/,
  ],
  backup: [/^\/painel\/saude$/, /^\/painel\/api\/estado$/],
};

export class RequisicaoRecusada extends Error {}

/** A trava de leitura. Exportada pra ser testada isoladamente. */
export function requisicaoPermitida(sistema: NomeSistema, metodo: string, caminho: string): boolean {
  const semQuery = caminho.split('?')[0];
  // Sem ".." nem barra dupla: o caminho e montado com entrada do modelo (ex.: id do pedido).
  if (semQuery.includes('..') || semQuery.includes('//')) return false;
  const listaGet = GET_PERMITIDO[sistema];
  if (listaGet) return metodo === 'GET' && listaGet.some((re) => re.test(semQuery));
  if (!semQuery.startsWith('/api/') && semQuery !== '/health') return false;
  if (metodo === 'GET') return true;
  if (metodo === 'POST') return POST_PERMITIDO[sistema].some((re) => re.test(semQuery));
  return false;
}

export class ErroDoSistema extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function chamar(
  nome: NomeSistema,
  caminho: string,
  opcoes: { metodo?: 'GET' | 'POST'; corpo?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  const metodo = opcoes.metodo ?? 'GET';
  const s = sistemas()[nome];

  if (!requisicaoPermitida(nome, metodo, caminho)) {
    throw new RequisicaoRecusada(`Bloqueado pela trava de leitura: ${metodo} ${caminho} no ${s.rotulo}.`);
  }
  if (!s.baseUrl) {
    throw new ErroDoSistema(`${s.rotulo} nao configurado no Gerente (falta a URL base).`);
  }

  const headers: Record<string, string> = { accept: 'application/json', ...cabecalhoDaChave(s) };
  if (opcoes.corpo !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${s.baseUrl}${caminho}`, {
      method: metodo,
      headers,
      body: opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined,
      signal: AbortSignal.timeout(opcoes.timeoutMs ?? config.sistemaTimeoutMs),
    });
  } catch (err: any) {
    const tempo = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ErroDoSistema(tempo ? `${s.rotulo} nao respondeu a tempo.` : `${s.rotulo} fora do ar ou inalcancavel (${err?.message || err}).`);
  }

  const texto = await res.text();
  let corpo: any = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = { texto: texto.slice(0, 300) };
  }

  if (res.status === 401 && corpo?.dashboardAuth) {
    throw new ErroDoSistema(`${s.rotulo}: o painel de vendas tem senha propria (DASHBOARD_PASSWORD). Coloque o mesmo valor em NF_DASHBOARD_KEY no Gerente.`, 401);
  }
  if (res.status === 401) throw new ErroDoSistema(`${s.rotulo} recusou a chave (401). Confira a chave dele no Gerente.`, 401);
  if (res.status === 403 && nome === 'ocorrencias') throw new ErroDoSistema(`${s.rotulo}: essa consulta e so para pessoas logadas no painel, a chave da IA nao tem acesso.`, 403);
  if (res.status === 404 && nome === 'backup') throw new ErroDoSistema(`${s.rotulo}: a rota de estado esta desligada (falta PANEL_API_KEY no servico de backup, versao 0.9.2+).`, 404);
  if (!res.ok) throw new ErroDoSistema(corpo?.mensagem || corpo?.erro || `${s.rotulo} respondeu HTTP ${res.status}.`, res.status);
  return corpo;
}

/**
 * Corta resultado grande demais pro contexto do modelo, avisando que cortou. Melhor o modelo
 * saber que viu so parte do que responder como se tivesse visto tudo.
 */
export function limitarResultado(saida: unknown, maxChars = config.resultadoMaxChars): unknown {
  const json = JSON.stringify(saida);
  if (json === undefined || json.length <= maxChars) return saida;
  return {
    aviso: `Resultado grande demais: mostrando so os primeiros ${maxChars} caracteres. Diga ao usuario que a lista esta incompleta ou peca um filtro mais especifico.`,
    parcial: json.slice(0, maxChars),
  };
}
