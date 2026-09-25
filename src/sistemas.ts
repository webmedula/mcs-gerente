import { config } from './config';

/**
 * CLIENTE DOS TRES SISTEMAS DA MCS.
 *
 * v1 e SOMENTE LEITURA, e isso nao depende do modelo "se comportar": a trava esta aqui.
 * - GET em qualquer rota /api/ ou /health.
 * - POST so na rota de ferramentas do ml-analytics, que executa funcoes de leitura (o POST
 *   existe porque a entrada pode ser um SQL longo).
 * Qualquer outra combinacao e recusada ANTES de sair da maquina. Quando a fase 2 (acoes com
 * confirmacao) chegar, ela entra por uma lista explicita de rotas de escrita, nao afrouxando isto.
 */

export type NomeSistema = 'analytics' | 'actions' | 'nf';

export interface Sistema {
  nome: NomeSistema;
  rotulo: string;
  baseUrl: string;
  apiKey: string;
}

export function sistemas(): Record<NomeSistema, Sistema> {
  return {
    analytics: { nome: 'analytics', rotulo: 'ml-analytics', baseUrl: config.analyticsBaseUrl, apiKey: config.analyticsApiKey },
    actions: { nome: 'actions', rotulo: 'ml-actions', baseUrl: config.actionsBaseUrl, apiKey: config.actionsApiKey },
    nf: { nome: 'nf', rotulo: 'tiny-pedidos-nf', baseUrl: config.nfBaseUrl, apiKey: config.nfApiKey },
  };
}

const POST_PERMITIDO: Record<NomeSistema, RegExp[]> = {
  analytics: [/^\/api\/assistente\/ferramenta\/[a-z0-9_]+$/],
  actions: [],
  nf: [],
};

export class RequisicaoRecusada extends Error {}

/** A trava de leitura. Exportada pra ser testada isoladamente. */
export function requisicaoPermitida(sistema: NomeSistema, metodo: string, caminho: string): boolean {
  const semQuery = caminho.split('?')[0];
  if (!semQuery.startsWith('/api/') && semQuery !== '/health') return false;
  // Sem ".." nem barra dupla: o caminho e montado com entrada do modelo (ex.: id do pedido).
  if (semQuery.includes('..') || semQuery.includes('//')) return false;
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

  const headers: Record<string, string> = { accept: 'application/json' };
  if (s.apiKey) headers['x-api-key'] = s.apiKey;
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

  if (res.status === 401) throw new ErroDoSistema(`${s.rotulo} recusou a chave (401). Confira a chave dele no Gerente.`, 401);
  if (!res.ok) throw new ErroDoSistema(corpo?.mensagem || `${s.rotulo} respondeu HTTP ${res.status}.`, res.status);
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
