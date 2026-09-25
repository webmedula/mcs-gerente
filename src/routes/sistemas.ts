import { FastifyInstance } from 'fastify';
import { chamar, sistemas } from '../sistemas';

export async function sistemasRoutes(app: FastifyInstance): Promise<void> {
  /** Testa pelo navegador se o Gerente alcanca cada sistema COM a chave certa. */
  app.get('/debug/sistemas', async () => {
    const s = sistemas();
    const testar = async (nome: 'analytics' | 'actions' | 'nf', caminho: string) => {
      const inicio = Date.now();
      try {
        await chamar(nome, caminho, { timeoutMs: 10000 });
        return { ok: true, ms: Date.now() - inicio, rotaTestada: caminho };
      } catch (err: any) {
        return { ok: false, ms: Date.now() - inicio, rotaTestada: caminho, erro: err?.message || String(err) };
      }
    };
    // Rotas /api/ de proposito: /health e aberta e nao provaria que a chave esta certa.
    const [a, ac, nf] = await Promise.all([
      testar('analytics', '/api/assistente/ferramentas'),
      testar('actions', '/api/status'),
      testar('nf', '/api/scheduler'),
    ]);
    return { [s.analytics.rotulo]: a, [s.actions.rotulo]: ac, [s.nf.rotulo]: nf };
  });
}
