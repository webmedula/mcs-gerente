import { config } from '../config';

/**
 * MEMORIA CURTA POR CONVERSA (v1.3).
 *
 * Antes cada mensagem do Telegram ia sozinha pro modelo: "e ontem?" nao fazia sentido porque ele
 * nao sabia do que se falava. Agora cada chat guarda as ultimas trocas (pergunta e resposta final,
 * em texto) e elas entram antes da pergunta nova.
 *
 * - So texto: os resultados das ferramentas NAO ficam guardados. Sao grandes, envelhecem rapido e o
 *   modelo pode consultar de novo. A resposta final ja resume o que importava.
 * - Em memoria do processo, por chat id, com validade. Reiniciou o servico, esqueceu. Nao e
 *   historico: e contexto da conversa em andamento.
 */

export interface Troca {
  pergunta: string;
  resposta: string;
  em: number;
}

const conversas = new Map<string, Troca[]>();

function validas(chave: string, agora: number): Troca[] {
  const lista = conversas.get(chave) ?? [];
  const limite = agora - config.memoriaMinutos * 60 * 1000;
  const vivas = lista.filter((t) => t.em >= limite);
  if (vivas.length !== lista.length) {
    if (vivas.length) conversas.set(chave, vivas);
    else conversas.delete(chave);
  }
  return vivas;
}

/** Trocas anteriores desta conversa, da mais antiga pra mais nova. */
export function lembrar(chave: string, agora = Date.now()): Troca[] {
  if (!chave || config.memoriaTrocas <= 0) return [];
  return validas(chave, agora);
}

/** Guarda uma troca concluida, mantendo so as ultimas N. */
export function guardar(chave: string, pergunta: string, resposta: string, agora = Date.now()): void {
  if (!chave || config.memoriaTrocas <= 0) return;
  const lista = validas(chave, agora);
  // Resposta cortada: o que importa e o fio da conversa, nao o texto inteiro.
  lista.push({ pergunta: pergunta.slice(0, 1000), resposta: resposta.slice(0, 1500), em: agora });
  conversas.set(chave, lista.slice(-config.memoriaTrocas));
}

/** /esquecer no Telegram e testes. */
export function esquecer(chave: string): void {
  conversas.delete(chave);
}

/** Mensagens no formato que os dois provedores aceitam (texto puro em user/assistant). */
export function comoMensagens(trocas: Troca[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const r: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const t of trocas) {
    r.push({ role: 'user', content: t.pergunta });
    r.push({ role: 'assistant', content: t.resposta });
  }
  return r;
}

/** So pra /debug/assistente: quantas conversas vivas e quantas trocas em cada. */
export function resumoDaMemoria(agora = Date.now()): Record<string, number> {
  const r: Record<string, number> = {};
  for (const chave of [...conversas.keys()]) {
    const v = validas(chave, agora);
    if (v.length) r[chave] = v.length;
  }
  return r;
}
