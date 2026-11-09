import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ANALYTICS_BASE_URL = 'http://analytics.test';
process.env.NF_BASE_URL = 'http://nf.test';
// ml-actions sem URL: fica fora do vigia.
process.env.ACTIONS_BASE_URL = '';
process.env.OCORRENCIAS_BASE_URL = 'http://oc.test';
process.env.BACKUP_BASE_URL = 'http://backup.test';

const { compararEstados, verificar, ALVOS } = await import('./vigia');
type Mem = Map<string, { estado: 'ok' | 'caido' | 'fora'; vezes: number; avisado: boolean }>;

const leitura = (id: string, estado: 'ok' | 'caido' | 'fora') => ({ id, rotulo: id, estado, detalhe: estado === 'fora' ? 'timeout' : undefined });

describe('compararEstados (puro)', () => {
  it('primeira leitura: avisa so o que ja esta caido ou fora', () => {
    const r = compararEstados(new Map(), [leitura('a', 'ok'), leitura('b', 'caido'), leitura('c', 'fora')]);
    expect(r.avisos).toHaveLength(2);
    expect(r.avisos[0]).toMatch(/b: login CAIU/);
    expect(r.avisos[1]).toMatch(/c: servico fora/);
    expect(r.memoria.get('a')).toEqual({ estado: 'ok', vezes: 1, avisado: false });
  });

  it('caiu e voltou avisam na hora; estado igual nao repete', () => {
    let mem: Mem = compararEstados(new Map(), [leitura('a', 'ok')]).memoria;
    let r = compararEstados(mem, [leitura('a', 'caido')]);
    expect(r.avisos).toEqual([expect.stringMatching(/a: login CAIU/)]);
    mem = r.memoria;
    r = compararEstados(mem, [leitura('a', 'caido')]);
    expect(r.avisos).toEqual([]);
    expect(r.memoria.get('a')?.vezes).toBe(2);
    r = compararEstados(r.memoria, [leitura('a', 'ok')]);
    expect(r.avisos).toEqual(['🟢 a: voltou.']);
  });

  it('fora do ar so avisa na segunda leitura seguida (timeout isolado nao vira mensagem)', () => {
    let mem: Mem = compararEstados(new Map(), [leitura('a', 'ok')]).memoria;
    let r = compararEstados(mem, [leitura('a', 'fora')]);
    expect(r.avisos).toEqual([]);
    r = compararEstados(r.memoria, [leitura('a', 'fora')]);
    expect(r.avisos).toEqual([expect.stringMatching(/a: servico fora/)]);
    r = compararEstados(r.memoria, [leitura('a', 'fora')]);
    expect(r.avisos).toEqual([]);
    r = compararEstados(r.memoria, [leitura('a', 'ok')]);
    expect(r.avisos).toEqual(['🟢 a: voltou.']);
  });

  it('timeout isolado seguido de ok nao gera nada', () => {
    const mem: Mem = compararEstados(new Map(), [leitura('a', 'ok')]).memoria;
    const r1 = compararEstados(mem, [leitura('a', 'fora')]);
    const r2 = compararEstados(r1.memoria, [leitura('a', 'ok')]);
    expect(r1.avisos).toEqual([]);
    expect(r2.avisos).toEqual([]);
  });
});

describe('verificar (com fetch simulado)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://analytics.test/api/oauth/ml/status') return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      if (url === 'http://analytics.test/api/tiny/status') return new Response(JSON.stringify({ authenticated: false, configurado: true }), { status: 200 });
      if (url === 'http://oc.test/api/admin/ml/status') return new Response(JSON.stringify({ configurado: false, conectado: false }), { status: 200 });
      if (url === 'http://backup.test/painel/api/estado') return new Response(JSON.stringify({ ok: false, alertas: ['Sem batimento do servico.', 'Pouco espaco em disco.'] }), { status: 200 });
      throw new Error('conexao recusada');
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('le ok, caido e fora, e ignora sistema sem URL', async () => {
    const r = await verificar();
    const por = Object.fromEntries(r.map((l) => [l.id, l.estado]));
    expect(por['analytics.ml']).toBe('ok');
    expect(por['analytics.tiny']).toBe('caido');
    expect(por['nf.tiny']).toBe('fora');
    expect(por['actions.ml']).toBeUndefined();
    expect(ALVOS.some((a) => a.id === 'actions.ml')).toBe(true);
    // v1.5: ML nao configurado na Central fica fora; backup com alerta vem como 'caido' com o texto dos alertas
    expect(por['ocorrencias.ml']).toBeUndefined();
    const bk = r.find((l) => l.id === 'backup.saude')!;
    expect(bk.estado).toBe('caido');
    expect(bk.tipo).toBe('saude');
    expect(bk.detalhe).toBe('Sem batimento do servico. Pouco espaco em disco.');
  });
  it('alvo de saude avisa com o texto do alerta e "sem alerta de novo" quando limpa', () => {
    const saude = (estado: 'ok' | 'caido', detalhe?: string) => ({ id: 'b', rotulo: 'Backup do Tiny', estado, detalhe, tipo: 'saude' as const });
    let r = compararEstados(new Map(), [saude('caido', 'Sem batimento.')]);
    expect(r.avisos).toEqual(['🔴 Backup do Tiny: com ALERTA na tela Saude (Sem batimento.).']);
    r = compararEstados(r.memoria, [saude('ok')]);
    expect(r.avisos).toEqual(['🟢 Backup do Tiny: sem alerta de novo.']);
  });
});
