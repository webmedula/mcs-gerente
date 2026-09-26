import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { NomeSistema, sistemas } from '../sistemas';

/**
 * DIAGNOSTICO — pra investigar o 401 intermitente do tiny-pedidos-nf.
 *
 * Bate em VARIAS rotas do mesmo sistema, na hora, e devolve status + cabecalhos que costumam
 * denunciar cache (Age, X-Cache, CF-Cache-Status, Via) ou mais de uma instancia respondendo
 * (Server, X-Powered-By, ou o proprio corpo variando entre chamadas identicas).
 *
 * Nunca devolve a chave: so o comprimento e um hash SHA-256 dela, pra confirmar que o valor
 * carregado no Gerente e o mesmo que voce colou, sem precisar colar de novo.
 */
export async function diagnosticoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/diagnostico/:sistema', async (req, reply) => {
    const nome = (req.params as { sistema: string }).sistema as NomeSistema;
    const s = sistemas()[nome];
    if (!s) {
      reply.code(404);
      return { mensagem: `Sistema desconhecido: ${nome}. Use analytics, actions ou nf.` };
    }
    if (!s.baseUrl) return { mensagem: `${s.rotulo} sem URL configurada.` };

    const rotas: Record<NomeSistema, string[]> = {
      nf: ['/health', '/api/scheduler', '/api/orders/pending', `/api/sales-report?data=${dataDeHoje()}`, '/api/dashboard?dias=1'],
      analytics: ['/health', '/api/assistente/ferramentas'],
      actions: ['/health', '/api/status'],
    };

    const cabecalhosDeInteresse = ['server', 'x-powered-by', 'age', 'x-cache', 'cf-cache-status', 'via', 'cache-control'];

    const testar = async (caminho: string, repeticoes = 1) => {
      const tentativas = [];
      for (let i = 0; i < repeticoes; i++) {
        const inicio = Date.now();
        try {
          const res = await fetch(`${s.baseUrl}${caminho}`, {
            headers: s.apiKey ? { 'x-api-key': s.apiKey, accept: 'application/json' } : { accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          const texto = await res.text();
          const cabecalhos: Record<string, string> = {};
          for (const h of cabecalhosDeInteresse) {
            const v = res.headers.get(h);
            if (v) cabecalhos[h] = v;
          }
          tentativas.push({
            status: res.status,
            ms: Date.now() - inicio,
            cabecalhos: Object.keys(cabecalhos).length ? cabecalhos : undefined,
            corpo: texto.slice(0, 200),
          });
        } catch (err: any) {
          tentativas.push({ erro: err?.message || String(err), ms: Date.now() - inicio });
        }
      }
      return repeticoes === 1 ? tentativas[0] : tentativas;
    };

    const resultado: Record<string, unknown> = {};
    for (const caminho of rotas[nome] ?? []) {
      resultado[caminho] = await testar(caminho);
    }
    // A mesma rota, 3 vezes seguidas: se o status variar de uma chamada pra outra com a MESMA
    // chave, e sinal de mais de uma instancia respondendo (uma com config antiga) ou de cache
    // por URL guardando uma resposta velha.
    const rotaRepetida = rotas[nome]?.[1] ?? rotas[nome]?.[0];
    if (rotaRepetida) resultado[`${rotaRepetida} (3x seguidas)`] = await testar(rotaRepetida, 3);

    return {
      sistema: s.rotulo,
      baseUrl: s.baseUrl,
      chave: s.apiKey
        ? { comprimento: s.apiKey.length, sha256: createHash('sha256').update(s.apiKey).digest('hex').slice(0, 16) + '…' }
        : 'sem chave configurada',
      testes: resultado,
    };
  });
}

function dataDeHoje(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
