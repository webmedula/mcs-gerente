import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { sistemas } from '../sistemas';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Aberta (sem chave), como nos outros servicos: e daqui que sai o diagnostico quando o deploy
   * nao sobe. Mostra so SE cada sistema esta configurado — nunca URL de chave nem dado da loja.
   */
  app.get('/health', async () => {
    const s = sistemas();
    return {
      status: 'ok',
      service: 'mcs-gerente',
      version: config.appVersion,
      node: process.version,
      sistemasConfigurados: Object.fromEntries(
        Object.values(s).map((x) => [x.rotulo, { url: !!x.baseUrl, chave: !!x.apiKey }]),
      ),
      telegram: !!config.telegramBotToken,
    };
  });
}
