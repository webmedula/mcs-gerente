import 'dotenv/config';

const semBarraFinal = (s: string) => s.replace(/\/+$/, '');

export const config = {
  /** Versao — atualize a cada release. Exibida em /health e no /start do bot. */
  appVersion: 'gerente v1 (2026-09-24)',

  port: Number(process.env.PORT || 3020),
  /** Protege /debug/* deste servico (aceita x-api-key ou ?key=). */
  serviceApiKey: process.env.SERVICE_API_KEY || '',

  // --- os tres sistemas da MCS -------------------------------------------------------------
  // Cada um com a SUA chave (a SERVICE_API_KEY daquele servico). O Gerente nunca acessa banco
  // de ninguem: so fala com as APIs, como o painel de cada um ja faz.
  analyticsBaseUrl: semBarraFinal(process.env.ANALYTICS_BASE_URL || ''),
  analyticsApiKey: process.env.ANALYTICS_API_KEY || '',

  actionsBaseUrl: semBarraFinal(process.env.ACTIONS_BASE_URL || ''),
  actionsApiKey: process.env.ACTIONS_API_KEY || '',

  nfBaseUrl: semBarraFinal(process.env.NF_BASE_URL || ''),
  nfApiKey: process.env.NF_API_KEY || '',

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
   * cruza dados usa mais passos que antes — por isso o padrao subiu de 6 para 8. */
  assistenteMaxPassos: Number(process.env.ASSISTENTE_MAX_PASSOS || 8),
  assistenteMaxTokens: Number(process.env.ASSISTENTE_MAX_TOKENS || 1500),

  // --- Telegram ------------------------------------------------------------------------------
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  /** Segredo no CAMINHO do webhook: sem ele o Telegram nem alcanca a rota. */
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  /** Quem pode conversar com o bot. VAZIO = ninguem (o bot so informa o proprio chat id). */
  telegramChatIds: (process.env.TELEGRAM_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Endereco publico deste servico — usado pra registrar o webhook no Telegram. */
  baseUrl: semBarraFinal(process.env.BASE_URL || ''),
};
