import { config } from './config';
import { logger } from './logger';
import { buildServer } from './server';
import { sistemas } from './sistemas';

async function main(): Promise<void> {
  const app = buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`mcs-gerente ${config.appVersion} rodando na porta ${config.port}`);

  // Sistema sem URL nao derruba o Gerente: as ferramentas dele so respondem que falta configurar.
  for (const s of Object.values(sistemas())) {
    if (!s.baseUrl) logger.warn(`[CONFIG] ${s.rotulo} sem URL: as ferramentas dele vao responder erro.`);
    else if (!s.apiKey) logger.warn(`[CONFIG] ${s.rotulo} sem chave: se ele exigir x-api-key, vai recusar.`);
  }
  if (!config.serviceApiKey) logger.warn('[SEGURANCA] SERVICE_API_KEY vazia: rotas /debug/* ficam desligadas.');
}

main().catch((err) => {
  logger.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
