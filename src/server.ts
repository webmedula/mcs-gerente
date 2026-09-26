import Fastify from 'fastify';
import { config } from './config';
import { logger } from './logger';
import { healthRoutes } from './routes/health';
import { telegramRoutes } from './routes/telegram';
import { sistemasRoutes } from './routes/sistemas';
import { diagnosticoRoutes } from './routes/diagnostico';

export function buildServer() {
  const app = Fastify({ logger: false });

  // Trata corpo JSON vazio como ausente em vez de erro.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  /**
   * Protege /debug/* (aceita x-api-key ou ?key=, pra abrir no navegador). Sem SERVICE_API_KEY o
   * servico se recusa a expor o /debug: ali da pra perguntar qualquer coisa ao bot e ler o
   * financeiro da loja, e o dominio e publico.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/debug/')) return;
    if (!config.serviceApiKey) {
      reply.code(503).send({ mensagem: 'Defina SERVICE_API_KEY no Gerente para liberar as rotas de diagnostico.' });
      return;
    }
    if (req.headers['x-api-key'] === config.serviceApiKey) return;
    if ((req.query as { key?: string } | undefined)?.key === config.serviceApiKey) return;
    reply.code(401).send({ mensagem: 'Rota de diagnostico protegida. Acrescente ?key=SUA_SERVICE_API_KEY na URL.' });
  });

  app.get('/', async () => ({ service: 'mcs-gerente', version: config.appVersion, docs: 'veja /health' }));

  app.register(healthRoutes);
  app.register(telegramRoutes);
  app.register(sistemasRoutes);
  app.register(diagnosticoRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error('Erro nao tratado:', err.message, err.stack);
    const status = (err as any).status || 500;
    reply.code(status).send({ mensagem: err.message || 'Erro interno' });
  });

  return app;
}
