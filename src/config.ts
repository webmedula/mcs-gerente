import 'dotenv/config';

const semBarraFinal = (s: string) => s.replace(/\/+$/, '');

export const config = {
  /** Versao — atualize a cada release. Exibida em /health e no /start do bot. */
  appVersion: 'gerente v1.4 (2026-11-08)',

  port: Number(process.env.PORT || 3020),
  /** Protege /debug/* deste servico (aceita x-api-key ou ?key=). */
  serviceApiKey: process.env.SERVICE_API_KEY || '',

  // --- os sistemas da MCS -------------------------------------------------------------
  // Cada um com a SUA chave (a SERVICE_API_KEY daquele servico). O Gerente nunca acessa banco
  // de ninguem: so fala com as APIs, como o painel de cada um ja faz.
  analyticsBaseUrl: semBarraFinal(process.env.ANALYTICS_BASE_URL || ''),
  analyticsApiKey: process.env.ANALYTICS_API_KEY || '',

  actionsBaseUrl: semBarraFinal(process.env.ACTIONS_BASE_URL || ''),
  actionsApiKey: process.env.ACTIONS_API_KEY || '',

  nfBaseUrl: semBarraFinal(process.env.NF_BASE_URL || ''),
  nfApiKey: process.env.NF_API_KEY || '',

  /** Central de Ocorrencias (mcs-ocorrencias). A chave NAO e a SERVICE_API_KEY: e uma chave mcsia_
   * criada no painel da Central (Equipe > Chaves do Gerente IA), enviada como Bearer. */
  ocorrenciasBaseUrl: semBarraFinal(process.env.OCORRENCIAS_BASE_URL || ''),
  ocorrenciasApiKey: process.env.OCORRENCIAS_API_KEY || '',

  /** Tempo maximo de espera por um sistema. O Tiny as vezes demora; mais que isso o Telegram
   * fica sem resposta e o usuario pergunta de novo. */
  sistemaTimeoutMs: Number(process.env.SISTEMA_TIMEOUT_MS || 25000),
  /** Teto do resultado de UMA ferramenta enviado ao modelo (caracteres de JSON). Resultado maior
   * e cortado com aviso: lista enorme gasta a resposta inteira antes da conclusao. */
  resultadoMaxChars: Number(process.env.RESULTADO_MAX_CHARS || 12000),

  // --- assistente ----------------------------------------------------------------------------
  /** 'anthropic' | 'openrouter'. Vazio = usa a chave que estiver configurada. */
  assistenteProvedor: process.env.ASSISTENTE_PROVEDOR || '',
  /** Id do modelo. Vazio funciona na Anthropic (ela pergunta a API); no OpenRouter e obrigatorio. */
  assistenteModelo: process.env.ASSISTENTE_MODELO || process.env.ANTHROPIC_MODEL || '',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: semBarraFinal(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
  anthropicVersion: process.env.ANTHROPIC_VERSION || '2023-06-01',

  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterBaseUrl: semBarraFinal(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
  /** Teto de idas e voltas com ferramentas numa pergunta. Com tres sistemas, uma pergunta que
   * cruza dados usa mais passos que antes. v1.3: 10, porque o panorama chama varias de uma vez e o modelo
   * costuma aprofundar em 2 ou 3 delas depois. */
  assistenteMaxPassos: Number(process.env.ASSISTENTE_MAX_PASSOS || 10),
  /** v1.3: subiu de 1500 pra 2500. Um panorama com sugestoes nao cabia em 1500 e saia cortado. */
  assistenteMaxTokens: Number(process.env.ASSISTENTE_MAX_TOKENS || 2500),
  /** Memoria curta por conversa (v1.3): quantas trocas o Gerente lembra em cada chat e por quantos
   * minutos. MEMORIA_TROCAS=0 desliga. */
  memoriaTrocas: Number(process.env.MEMORIA_TROCAS || 10),
  memoriaMinutos: Number(process.env.MEMORIA_MINUTOS || 180),

  /** Vigia de logins (v1.4): a cada N minutos confere os logins do ML e do Tiny nos servicos e
   * avisa no Telegram so quando algo muda. 0 desliga. */
  vigiaMinutos: Number(process.env.VIGIA_MINUTOS || 30),

  // --- Telegram ------------------------------------------------------------------------------
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  /** Segredo no CAMINHO do webhook: sem ele o Telegram nem alcanca a rota. */
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  /** Quem pode conversar com o bot. VAZIO = ninguem (o bot so informa o proprio chat id). */
  telegramChatIds: (process.env.TELEGRAM_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Hora (0-23, Brasilia) do aviso diario de promocoes novas do ML. -1 desliga. */
  avisoPromocoesHora: Number(process.env.AVISO_PROMOCOES_HORA ?? 9),
  /** Endereco publico deste servico — usado pra registrar o webhook no Telegram. */
  baseUrl: semBarraFinal(process.env.BASE_URL || ''),
};
