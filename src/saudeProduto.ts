import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { config } from './config';
import { logger } from './logger';
import { chamar, sistemas } from './sistemas';
import { enviar } from './routes/telegram';
import { horaEmBrasilia } from './avisoPromocoes';

/**
 * SAUDE DO PRODUTO (v1.6) — relatorio mensal por produto.
 *
 * Tres sistemas viam o mesmo problema de um produto, cada um pela metade:
 * - Central de Ocorrencias: as reclamacoes (motivo do ML, conferencia da devolucao, prejuizo);
 * - Bot de perguntas (mcs-bot): as perguntas que se repetem no anuncio;
 * - ml-analytics: a nota do anuncio (e, pela margem, o SKU e as unidades vendidas de cada anuncio).
 *
 * Aqui eles se juntam por produto (SKU quando se sabe; senao, o anuncio MLB) e viram tres listas de acao:
 * cobrar o fornecedor (defeito, quebra, peca faltando), corrigir o anuncio (perguntas repetidas sobre o
 * produto, "diferente do anunciado") e nota baixa. Sem IA: os numeros saem dos sistemas, o texto e montado
 * aqui. Somente leitura, como o resto do Gerente.
 */

// ------------------------------------------------------------------ periodo

export interface Periodo {
  mes: string; // AAAA-MM
  desde: string; // AAAA-MM-DD
  ate: string; // AAAA-MM-DD
  nome: string; // "outubro de 2026"
}

const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function periodoDoMes(mes: string): Periodo | null {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m) return null;
  const ano = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || n > 12) return null;
  const ultimo = new Date(Date.UTC(ano, n, 0)).getUTCDate();
  return { mes, desde: `${mes}-01`, ate: `${mes}-${String(ultimo).padStart(2, '0')}`, nome: `${MESES[n - 1].replace('marco', 'março')} de ${ano}` };
}

/** Mes anterior a um AAAA-MM. */
export function mesAntes(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

/** O ultimo mes fechado, no fuso de Brasilia. */
export function ultimoMesFechado(agora = new Date()): string {
  return mesAntes(horaEmBrasilia(agora).dia.slice(0, 7));
}

// ------------------------------------------------------------------ classificacao

const normalizar = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export type Categoria = 'qualidade' | 'anuncio' | 'entrega' | 'outros';

export const NOME_CATEGORIA: Record<Categoria, string> = {
  qualidade: 'defeito, quebra ou peça faltando',
  anuncio: 'diferente do anunciado ou não serve',
  entrega: 'entrega ou produto trocado na separação',
  outros: 'outros motivos',
};

const TERMOS_ANUNCIO = ['diferente do anunciado', 'diferente do anuncio', 'nao e o que', 'nao era o que', 'nao corresponde', 'descricao', 'incompativel', 'nao serve', 'nao serviu', 'nao encaixa', 'tamanho errado', 'medida errada'];
const TERMOS_QUALIDADE = ['defeito', 'defeituoso', 'danificado', 'quebrad', 'trincad', 'avariad', 'nao funciona', 'parou de funcionar', 'nao liga', 'incompleto', 'falta', 'faltando', 'faltam', 'vazamento', 'queimad'];
const TERMOS_ENTREGA = ['nao recebi', 'nao chegou', 'atraso', 'atrasad', 'extravi', 'produto errado', 'enviaram outro', 'veio outro'];

/**
 * Codigos de motivo que o Mercado Livre manda nas reclamacoes e devolucoes (vistos no primeiro relatorio real,
 * outubro de 2026). Valem mais que o tipo da ocorrencia: a Central marca como "defeito" muita devolucao que no ML
 * e arrependimento. Codigo desconhecido cai nas palavras-chave abaixo.
 */
export const MOTIVOS_ML: Record<string, { nome: string; categoria: Categoria }> = {
  repentant_buyer: { nome: 'Comprador se arrependeu', categoria: 'outros' },
  not_working_item: { nome: 'Não funciona', categoria: 'qualidade' },
  broken_item: { nome: 'Chegou quebrado', categoria: 'qualidade' },
  damaged_package_broken_item: { nome: 'Embalagem danificada, produto quebrado', categoria: 'qualidade' },
  damaged_package_not_working_item: { nome: 'Embalagem danificada, não funciona', categoria: 'qualidade' },
  damaged_package_missing_item: { nome: 'Embalagem danificada, faltando item', categoria: 'qualidade' },
  missing_accessories: { nome: 'Faltando acessórios', categoria: 'qualidade' },
  missing_item: { nome: 'Faltando item', categoria: 'qualidade' },
  missing_parts: { nome: 'Faltando peças', categoria: 'qualidade' },
  defective_item: { nome: 'Com defeito', categoria: 'qualidade' },
  different_than_published: { nome: 'Diferente do anunciado', categoria: 'anuncio' },
  uncompats_item_with_vehicle: { nome: 'Não serve no veículo', categoria: 'anuncio' },
  uncompats_item_with_vehicle_acc: { nome: 'Não serve no veículo', categoria: 'anuncio' },
  different_color_or_size: { nome: 'Cor ou tamanho diferente', categoria: 'anuncio' },
  different_color_or_size_acc: { nome: 'Cor ou tamanho diferente', categoria: 'anuncio' },
  different_item_other: { nome: 'Veio outro produto', categoria: 'entrega' },
  different_item: { nome: 'Veio outro produto', categoria: 'entrega' },
  not_received: { nome: 'Não recebeu', categoria: 'entrega' },
};

/** Nome em portugues de um motivo do ML (o codigo cru quando nao conhecemos). */
export function nomeDoMotivo(motivo: string): string {
  return MOTIVOS_ML[motivo.trim().toLowerCase()]?.nome ?? motivo;
}

/** Em que lista uma reclamacao entra. Pura. O codigo do ML vale mais; depois a conferencia, as palavras e o tipo. */
export function categoriaDaReclamacao(o: { tipo?: string | null; motivoMl?: string | null; conferencia?: string | null; motivoReal?: string | null }): Categoria {
  const codigo = MOTIVOS_ML[String(o.motivoMl ?? '').trim().toLowerCase()];
  if (codigo) return codigo.categoria;
  const texto = normalizar(`${o.motivoMl ?? ''} | ${o.motivoReal ?? ''}`);
  if (o.tipo === 'diferente_anuncio' || TERMOS_ANUNCIO.some((t) => texto.includes(t))) return 'anuncio';
  if (o.tipo === 'defeito' || o.conferencia === 'danificado' || o.conferencia === 'incompleto' || TERMOS_QUALIDADE.some((t) => texto.includes(t))) return 'qualidade';
  if (o.tipo === 'atraso' || o.tipo === 'nao_recebido' || o.tipo === 'errado' || TERMOS_ENTREGA.some((t) => texto.includes(t))) return 'entrega';
  return 'outros';
}

/** Assuntos de pergunta que dizem algo sobre o PRODUTO/ANUNCIO (frete, preco e nota fiscal nao). */
export const ASSUNTOS_DO_ANUNCIO = new Set(['compatibilidade', 'medidas', 'kit_lado', 'instalacao', 'original']);

// ------------------------------------------------------------------ montagem

export interface Fontes {
  reclamacoes: any; // GET /api/admin/saude-produtos da Central (ou { erro })
  reclamacoesMesAnterior: any;
  perguntas: any; // GET /api/saude-produtos do mcs-bot (ou { erro })
  notas: any; // GET /api/ratings do ml-analytics (ou { erro })
  margem: any; // GET /api/margem do ml-analytics: SKU e unidades por anuncio (ou { erro })
}

export interface ProdutoSaude {
  chave: string;
  sku: string | null;
  titulo: string;
  anuncios: string[];
  unidades30d: number | null;
  reclamacoes: {
    total: number;
    mesAnterior: number;
    porCategoria: Record<Categoria, number>;
    motivos: Array<{ motivo: string; vezes: number }>;
    conferencias: Array<{ conferencia: string; vezes: number }>;
    observacoes: string[];
    prejuizo: number;
    reputacaoAfetada: number;
    protocolos: string[];
  };
  perguntas: {
    total: number;
    sobreOProduto: number;
    porAssunto: Array<{ nome: string; quantidade: number }>;
    repetidas: Array<{ nome: string; quantidade: number; exemplo: string; sobreOProduto: boolean }>;
  };
  nota: { valor: number; opinioes: number | null; anuncio: string; abaixoDoLimite: boolean } | null;
  acoes: { cobrarFornecedor: boolean; corrigirAnuncio: boolean; notaBaixa: boolean };
  /** Para ordenar: quanto maior, mais urgente. */
  peso: number;
}

export interface RelatorioSaude {
  periodo: Periodo;
  geradoEm: string;
  totais: { reclamacoes: number; reclamacoesMesAnterior: number | null; semProduto: number; perguntas: number; anunciosComNotaBaixa: number; limiteDaNota: number | null };
  produtos: ProdutoSaude[];
  cobrarFornecedor: ProdutoSaude[];
  corrigirAnuncio: ProdutoSaude[];
  notaBaixa: ProdutoSaude[];
  /** Fonte que nao respondeu: o relatorio sai assim mesmo, dizendo o que faltou. */
  faltou: string[];
  /** v1.7.1: os limites usados (para conferir pelo /debug se a variavel de ambiente foi lida). */
  criterios: { minReclamacoes: number; minRepetidas: number };
}

const falhou = (r: unknown): boolean => !r || (typeof r === 'object' && 'erro' in (r as any));
const skuNorm = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim().toUpperCase() : null);
const mlbNorm = (s: unknown): string | null => (typeof s === 'string' && /^MLB\d+$/i.test(s.trim()) ? s.trim().toUpperCase() : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

function topContagem(valores: string[], max: number): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of valores) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
}

/** Junta as fontes num relatorio. Pura (testavel sem rede). */
export function montarRelatorio(f: Fontes, periodo: Periodo, opcoes = { minReclamacoes: config.saudeMinReclamacoes, minRepetidas: config.saudeMinPerguntasRepetidas }, agora = new Date()): RelatorioSaude {
  const faltou: string[] = [];
  if (falhou(f.reclamacoes)) faltou.push(`Reclamações (Central de Ocorrências): ${f.reclamacoes?.erro ?? 'sem resposta'}`);
  if (falhou(f.perguntas)) faltou.push(`Perguntas (bot de perguntas): ${f.perguntas?.erro ?? 'sem resposta'}`);
  if (falhou(f.notas)) faltou.push(`Nota dos anúncios (ml-analytics): ${f.notas?.erro ?? 'sem resposta'}`);
  // v1.7.1: sem a margem, o relatório não sabe o SKU de cada anúncio (o mesmo produto aparece uma vez por anúncio) nem as vendas.
  if (falhou(f.margem)) faltou.push(`SKU e vendas por anúncio (margem do ml-analytics): ${f.margem?.erro ?? 'sem resposta'}. Sem isso, cada anúncio aparece separado.`);

  const ocorrencias: any[] = !falhou(f.reclamacoes) && Array.isArray(f.reclamacoes?.ocorrencias) ? f.reclamacoes.ocorrencias : [];
  const anteriores: any[] = !falhou(f.reclamacoesMesAnterior) && Array.isArray(f.reclamacoesMesAnterior?.ocorrencias) ? f.reclamacoesMesAnterior.ocorrencias : [];
  const anunciosBot: any[] = !falhou(f.perguntas) && Array.isArray(f.perguntas?.anuncios) ? f.perguntas.anuncios : [];
  const notas: any[] = !falhou(f.notas) && Array.isArray(f.notas?.items) ? f.notas.items : [];
  const margem: any[] = !falhou(f.margem) && Array.isArray(f.margem?.anuncios) ? f.margem.anuncios : [];
  const limite: number | null = typeof f.notas?.limite === 'number' ? f.notas.limite : null;
  const minOpinioes: number = typeof f.notas?.minOpinioes === 'number' ? f.notas.minOpinioes : 1;

  // 1. Anuncio -> SKU, de todas as fontes que sabem (margem do analytics primeiro: e o cadastro do ML).
  const skuDoAnuncio = new Map<string, string>();
  const titulos = new Map<string, string>();
  const unidadesDoAnuncio = new Map<string, number>();
  const anotar = (itemId: unknown, sku: unknown, titulo?: unknown) => {
    const mlb = mlbNorm(itemId);
    const s = skuNorm(sku);
    if (mlb && s && !skuDoAnuncio.has(mlb)) skuDoAnuncio.set(mlb, s);
    if (mlb && typeof titulo === 'string' && titulo && !titulos.has(mlb)) titulos.set(mlb, titulo);
  };
  for (const a of margem) {
    anotar(a.itemId, a.sku, a.titulo);
    const mlb = mlbNorm(a.itemId);
    if (mlb && typeof a.unidades === 'number') unidadesDoAnuncio.set(mlb, a.unidades);
  }
  for (const o of [...ocorrencias, ...anteriores]) for (const p of o.produtos ?? []) anotar(p.itemId, p.sku, p.titulo);
  for (const a of anunciosBot) anotar(a.itemId, a.sku, a.titulo);
  for (const n of notas) anotar(n.itemId, null, n.title);

  const chaveDe = (itemId: unknown, sku: unknown): string | null => {
    const s = skuNorm(sku) ?? (mlbNorm(itemId) ? skuDoAnuncio.get(mlbNorm(itemId)!) ?? null : null);
    if (s) return `SKU:${s}`;
    const mlb = mlbNorm(itemId);
    if (!mlb) return null;
    // v1.7.1: sem SKU, anuncios com o MESMO titulo contam como um produto (clones da recriacao, por exemplo).
    const titulo = titulos.get(mlb);
    return titulo ? `TITULO:${normalizar(titulo).replace(/\s+/g, ' ').trim()}` : `MLB:${mlb}`;
  };

  const produtos = new Map<string, ProdutoSaude & { _cats: Categoria[]; _motivos: string[]; _conf: string[] }>();
  const produto = (chave: string, titulo?: unknown, itemId?: unknown) => {
    let p = produtos.get(chave);
    if (!p) {
      p = {
        chave,
        sku: chave.startsWith('SKU:') ? chave.slice(4) : null,
        titulo: '',
        anuncios: [],
        unidades30d: null,
        reclamacoes: { total: 0, mesAnterior: 0, porCategoria: { qualidade: 0, anuncio: 0, entrega: 0, outros: 0 }, motivos: [], conferencias: [], observacoes: [], prejuizo: 0, reputacaoAfetada: 0, protocolos: [] },
        perguntas: { total: 0, sobreOProduto: 0, porAssunto: [], repetidas: [] },
        nota: null,
        acoes: { cobrarFornecedor: false, corrigirAnuncio: false, notaBaixa: false },
        peso: 0,
        _cats: [],
        _motivos: [],
        _conf: [],
      };
      produtos.set(chave, p);
    }
    const mlb = mlbNorm(itemId);
    if (mlb && !p.anuncios.includes(mlb)) p.anuncios.push(mlb);
    if (!p.titulo) p.titulo = (typeof titulo === 'string' && titulo) || (mlb && titulos.get(mlb)) || '';
    return p;
  };

  // 2. Reclamacoes do mes (uma reclamacao com dois produtos conta para os dois).
  let semProduto = 0;
  for (const o of ocorrencias) {
    const chaves = new Set<string>();
    for (const item of o.produtos ?? []) {
      const k = chaveDe(item.itemId, item.sku);
      if (!k || chaves.has(k)) continue;
      chaves.add(k);
      const p = produto(k, item.titulo, item.itemId);
      const cat = categoriaDaReclamacao(o);
      p.reclamacoes.total++;
      p._cats.push(cat);
      if (o.motivoMl) p._motivos.push(nomeDoMotivo(String(o.motivoMl)));
      else if (o.tipoNome) p._motivos.push(String(o.tipoNome));
      if (o.conferenciaNome) p._conf.push(String(o.conferenciaNome));
      const obs = [o.motivoReal, o.conferenciaObs].filter((x) => typeof x === 'string' && x.trim()).join(' · ');
      if (obs && p.reclamacoes.observacoes.length < 5) p.reclamacoes.observacoes.push(obs.slice(0, 160));
      if (typeof o.custo === 'number' && o.custo > 0) p.reclamacoes.prejuizo = r2(p.reclamacoes.prejuizo + o.custo);
      if (o.reputacaoAfetada === true) p.reclamacoes.reputacaoAfetada++;
      if (o.protocolo) p.reclamacoes.protocolos.push(String(o.protocolo));
    }
    if (chaves.size === 0) semProduto++;
  }
  // Mes anterior: so a contagem por produto, para comparar (entra em quem estiver no relatorio).
  const anteriorPorChave = new Map<string, number>();
  for (const o of anteriores) {
    const chaves = new Set<string>();
    for (const item of o.produtos ?? []) {
      const k = chaveDe(item.itemId, item.sku);
      if (k) chaves.add(k);
    }
    for (const k of chaves) anteriorPorChave.set(k, (anteriorPorChave.get(k) ?? 0) + 1);
  }

  // 3. Perguntas por anuncio.
  for (const a of anunciosBot) {
    const k = chaveDe(a.itemId, a.sku);
    if (!k) continue;
    const p = produto(k, a.titulo, a.itemId);
    p.perguntas.total += Number(a.perguntas) || 0;
    for (const x of a.porAssunto ?? []) {
      const atual = p.perguntas.porAssunto.find((y) => y.nome === x.nome);
      if (atual) atual.quantidade += Number(x.quantidade) || 0;
      else p.perguntas.porAssunto.push({ nome: String(x.nome), quantidade: Number(x.quantidade) || 0 });
      if (ASSUNTOS_DO_ANUNCIO.has(x.assunto)) p.perguntas.sobreOProduto += Number(x.quantidade) || 0;
    }
    for (const g of a.repetidas ?? []) {
      p.perguntas.repetidas.push({ nome: String(g.nome), quantidade: Number(g.quantidade) || 0, exemplo: String(g.exemplos?.[0] ?? ''), sobreOProduto: ASSUNTOS_DO_ANUNCIO.has(g.assunto) });
    }
  }

  // 4. Nota: entra todo anuncio abaixo do limite e, para quem ja esta no relatorio, a pior nota dos anuncios dele.
  for (const n of notas) {
    const mlb = mlbNorm(n.itemId);
    if (!mlb || typeof n.nota !== 'number') continue;
    const k = chaveDe(mlb, null)!;
    const abaixo = limite != null && n.nota < limite && (n.totalAvaliacoes == null || n.totalAvaliacoes >= minOpinioes);
    if (!abaixo && !produtos.has(k)) continue;
    const p = produto(k, n.title, mlb);
    if (!p.nota || n.nota < p.nota.valor) p.nota = { valor: n.nota, opinioes: n.totalAvaliacoes ?? null, anuncio: mlb, abaixoDoLimite: abaixo };
  }

  // 5. Fecha cada produto: contagens, unidades, acoes e peso.
  const lista: ProdutoSaude[] = [];
  for (const p of produtos.values()) {
    for (const c of p._cats) p.reclamacoes.porCategoria[c]++;
    p.reclamacoes.mesAnterior = anteriorPorChave.get(p.chave) ?? 0;
    p.reclamacoes.motivos = topContagem(p._motivos, 4).map(([motivo, vezes]) => ({ motivo, vezes }));
    p.reclamacoes.conferencias = topContagem(p._conf, 4).map(([conferencia, vezes]) => ({ conferencia, vezes }));
    p.perguntas.porAssunto.sort((a, b) => b.quantidade - a.quantidade);
    p.perguntas.repetidas.sort((a, b) => Number(b.sobreOProduto) - Number(a.sobreOProduto) || b.quantidade - a.quantidade);
    p.perguntas.repetidas = p.perguntas.repetidas.slice(0, 4);
    const unidades = p.anuncios.map((a) => unidadesDoAnuncio.get(a)).filter((u): u is number => typeof u === 'number');
    p.unidades30d = unidades.length ? unidades.reduce((s, u) => s + u, 0) : null;
    if (!p.titulo) p.titulo = p.sku ? `SKU ${p.sku}` : p.anuncios[0] ?? p.chave;

    const qualidade = p.reclamacoes.porCategoria.qualidade;
    const doAnuncio = p.reclamacoes.porCategoria.anuncio;
    const repetidaSobreProduto = p.perguntas.repetidas.some((g) => g.sobreOProduto && g.quantidade >= opcoes.minRepetidas);
    p.acoes = {
      cobrarFornecedor: qualidade >= opcoes.minReclamacoes,
      corrigirAnuncio: doAnuncio >= 1 || repetidaSobreProduto,
      notaBaixa: !!p.nota?.abaixoDoLimite,
    };
    const somaRepetidas = p.perguntas.repetidas.filter((g) => g.sobreOProduto).reduce((s, g) => s + g.quantidade, 0);
    p.peso = qualidade * 3 + doAnuncio * 3 + p.reclamacoes.porCategoria.entrega + p.reclamacoes.porCategoria.outros + (p.acoes.notaBaixa ? 4 : 0) + somaRepetidas / 2 + p.reclamacoes.reputacaoAfetada;
    const { _cats, _motivos, _conf, ...limpo } = p;
    lista.push(limpo);
  }
  lista.sort((a, b) => b.peso - a.peso || b.reclamacoes.total - a.reclamacoes.total);

  return {
    periodo,
    geradoEm: agora.toISOString(),
    totais: {
      reclamacoes: ocorrencias.length,
      reclamacoesMesAnterior: falhou(f.reclamacoesMesAnterior) ? null : anteriores.length,
      semProduto,
      perguntas: !falhou(f.perguntas) ? Number(f.perguntas?.total) || 0 : 0,
      anunciosComNotaBaixa: lista.filter((p) => p.acoes.notaBaixa).length,
      limiteDaNota: limite,
    },
    produtos: lista,
    cobrarFornecedor: lista.filter((p) => p.acoes.cobrarFornecedor),
    corrigirAnuncio: lista.filter((p) => p.acoes.corrigirAnuncio),
    notaBaixa: lista.filter((p) => p.acoes.notaBaixa).sort((a, b) => (a.nota?.valor ?? 5) - (b.nota?.valor ?? 5)),
    faltou,
    criterios: { minReclamacoes: opcoes.minReclamacoes, minRepetidas: opcoes.minRepetidas },
  };
}

// ------------------------------------------------------------------ texto (Telegram)

const reais = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const nota1 = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nomeCurto = (p: ProdutoSaude) => `${p.titulo.length > 60 ? p.titulo.slice(0, 57) + '...' : p.titulo}${p.sku ? ` (SKU ${p.sku})` : ''}`;

function porVendas(p: ProdutoSaude, n: number): string {
  if (!p.unidades30d) return '';
  return ` de ${p.unidades30d} vendidos em 30 dias (${nota1((n / p.unidades30d) * 100)}%)`;
}

export function linhaFornecedor(p: ProdutoSaude): string {
  const q = p.reclamacoes.porCategoria.qualidade;
  const partes = [`${q} reclamação(ões) de ${NOME_CATEGORIA.qualidade}${porVendas(p, q)}`];
  if (p.reclamacoes.motivos.length) partes.push(`motivos: ${p.reclamacoes.motivos.slice(0, 2).map((m) => `"${m.motivo}" (${m.vezes})`).join(', ')}`);
  if (p.reclamacoes.conferencias.length) partes.push(`na devolução: ${p.reclamacoes.conferencias.slice(0, 2).map((c) => `${c.conferencia.toLowerCase()} (${c.vezes})`).join(', ')}`);
  if (p.reclamacoes.prejuizo > 0) partes.push(`prejuízo ${reais(p.reclamacoes.prejuizo)}`);
  return `${nomeCurto(p)}: ${partes.join('; ')}.`;
}

export function linhaAnuncio(p: ProdutoSaude, minRepetidas = config.saudeMinPerguntasRepetidas): string {
  const partes: string[] = [];
  for (const g of p.perguntas.repetidas.filter((x) => x.sobreOProduto && x.quantidade >= minRepetidas).slice(0, 2)) {
    partes.push(`${g.quantidade} perguntas iguais sobre ${g.nome.toLowerCase()} ("${g.exemplo.slice(0, 70)}")`);
  }
  const d = p.reclamacoes.porCategoria.anuncio;
  if (d) partes.push(`${d} reclamação(ões) de ${NOME_CATEGORIA.anuncio}`);
  return `${nomeCurto(p)}: ${partes.join('; ')}.`;
}

export function linhaNota(p: ProdutoSaude): string {
  const n = p.nota!;
  const extra = p.reclamacoes.total ? `; ${p.reclamacoes.total} reclamação(ões) no mês` : '';
  return `${nomeCurto(p)}: nota ${nota1(n.valor)}${n.opinioes != null ? ` com ${n.opinioes} opiniões` : ''} (anúncio ${n.anuncio})${extra}.`;
}

export function relatorioEmTexto(r: RelatorioSaude, link?: string, max = 5): string {
  const t = r.totais;
  const cmp = t.reclamacoesMesAnterior == null ? '' : ` (mês anterior: ${t.reclamacoesMesAnterior})`;
  const linhas: string[] = [
    `🩺 Saúde dos produtos — ${r.periodo.nome}`,
    '',
    `Reclamações: ${t.reclamacoes}${cmp} · Perguntas: ${t.perguntas} · Anúncios com nota abaixo de ${t.limiteDaNota != null ? nota1(t.limiteDaNota) : '—'}: ${t.anunciosComNotaBaixa}`,
  ];
  const bloco = (titulo: string, itens: ProdutoSaude[], fmt: (p: ProdutoSaude) => string) => {
    linhas.push('', `${titulo} (${itens.length})`);
    if (!itens.length) linhas.push('Nada neste mês.');
    itens.slice(0, max).forEach((p, i) => linhas.push(`${i + 1}. ${fmt(p)}`));
    if (itens.length > max) linhas.push(`... e mais ${itens.length - max} no relatório completo.`);
  };
  bloco('📦 Cobrar o fornecedor', r.cobrarFornecedor, linhaFornecedor);
  bloco('📝 Corrigir o anúncio', r.corrigirAnuncio, (p) => linhaAnuncio(p));
  bloco('⭐ Nota baixa', r.notaBaixa, linhaNota);
  if (t.semProduto) linhas.push('', `${t.semProduto} reclamação(ões) sem produto identificado ficaram de fora.`);
  if (r.faltou.length) linhas.push('', '⚠️ Faltou:', ...r.faltou.map((x) => `- ${x}`));
  if (link) linhas.push('', `Relatório completo: ${link}`);
  return linhas.join('\n');
}

// ------------------------------------------------------------------ pagina (HTML)

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function cartao(p: ProdutoSaude): string {
  const selos = [
    p.acoes.cobrarFornecedor ? '<span class="selo s-forn">Cobrar fornecedor</span>' : '',
    p.acoes.corrigirAnuncio ? '<span class="selo s-anun">Corrigir anúncio</span>' : '',
    p.acoes.notaBaixa ? '<span class="selo s-nota">Nota baixa</span>' : '',
  ].join('');
  const rc = p.reclamacoes;
  const cats = (Object.keys(rc.porCategoria) as Categoria[]).filter((c) => rc.porCategoria[c]).map((c) => `${rc.porCategoria[c]} de ${NOME_CATEGORIA[c]}`).join(' · ');
  const anuncios = p.anuncios.map((a) => `<a href="https://produto.mercadolivre.com.br/${esc(a.replace(/^MLB/, 'MLB-'))}" target="_blank" rel="noopener">${esc(a)}</a>`).join(', ');
  return `<article class="cartao">
  <header><h3>${esc(p.titulo)}</h3><div class="selos">${selos}</div></header>
  <p class="meta">${p.sku ? `SKU <b>${esc(p.sku)}</b> · ` : ''}${anuncios || 'sem anúncio identificado'}${p.unidades30d != null ? ` · ${p.unidades30d} vendidos nos últimos 30 dias` : ''}</p>
  <div class="grade">
    <section><h4>Reclamações</h4>
      <p class="num">${rc.total}<small> no mês · ${rc.mesAnterior} no anterior</small></p>
      ${cats ? `<p>${esc(cats)}</p>` : ''}
      ${rc.motivos.length ? `<ul>${rc.motivos.map((m) => `<li>${esc(m.motivo)} <b>(${m.vezes})</b></li>`).join('')}</ul>` : ''}
      ${rc.conferencias.length ? `<p class="sub">Na devolução: ${rc.conferencias.map((c) => `${esc(c.conferencia.toLowerCase())} (${c.vezes})`).join(', ')}</p>` : ''}
      ${rc.observacoes.length ? `<p class="sub">Anotado pela equipe: ${rc.observacoes.map((o) => `“${esc(o)}”`).join(' ')}</p>` : ''}
      ${rc.prejuizo > 0 ? `<p class="sub">Prejuízo: <b>${reais(rc.prejuizo)}</b></p>` : ''}
      ${rc.reputacaoAfetada ? `<p class="sub">${rc.reputacaoAfetada} afetaram a reputação</p>` : ''}
      ${rc.protocolos.length ? `<p class="sub">Protocolos: ${rc.protocolos.slice(0, 8).map(esc).join(', ')}</p>` : ''}
    </section>
    <section><h4>Perguntas</h4>
      <p class="num">${p.perguntas.total}<small> no mês · ${p.perguntas.sobreOProduto} sobre o produto</small></p>
      ${p.perguntas.repetidas.length ? `<ul>${p.perguntas.repetidas.map((g) => `<li>${g.quantidade}× ${esc(g.nome.toLowerCase())}: “${esc(g.exemplo)}”</li>`).join('')}</ul>` : '<p class="sub">Nenhuma pergunta repetida.</p>'}
    </section>
    <section><h4>Nota do anúncio</h4>
      ${p.nota ? `<p class="num">${nota1(p.nota.valor)}<small>${p.nota.opinioes != null ? ` · ${p.nota.opinioes} opiniões` : ''}</small></p><p class="sub">Pior nota entre os anúncios (${esc(p.nota.anuncio)})</p>` : '<p class="sub">Sem nota lida.</p>'}
    </section>
  </div>
</article>`;
}

export function relatorioEmHtml(r: RelatorioSaude): string {
  const t = r.totais;
  const lista = (titulo: string, explica: string, itens: ProdutoSaude[]) =>
    `<h2>${titulo} <span class="cont">${itens.length}</span></h2><p class="explica">${explica}</p>${itens.length ? itens.map(cartao).join('') : '<p class="vazio">Nada neste mês.</p>'}`;
  const outros = r.produtos.filter((p) => !p.acoes.cobrarFornecedor && !p.acoes.corrigirAnuncio && !p.acoes.notaBaixa && p.reclamacoes.total > 0);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saúde dos produtos — ${esc(r.periodo.nome)}</title>
<style>
:root{--fundo:#f6f7f9;--cartao:#fff;--texto:#1d2330;--sub:#5b6474;--borda:#e2e5ea;--forn:#b42318;--anun:#a15c07;--nota:#5925dc}
@media (prefers-color-scheme:dark){:root{--fundo:#12151b;--cartao:#1b1f27;--texto:#e8eaee;--sub:#a3abb8;--borda:#2c323d;--forn:#f97066;--anun:#fdb022;--nota:#a48afb}}
*{box-sizing:border-box}body{margin:0;background:var(--fundo);color:var(--texto);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 4px}
.explica,.sub,.meta{color:var(--sub)}.sub{font-size:13.5px;margin:6px 0}.meta{font-size:13.5px;margin:2px 0 12px}
.totais{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}
.totais div,.cartao{background:var(--cartao);border:1px solid var(--borda);border-radius:12px;padding:14px 16px}
.totais b{display:block;font-size:26px}.cartao{margin:12px 0}.cartao header{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:baseline}
.cartao h3{font-size:16px;margin:0}.grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
h4{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--sub)}.num{font-size:22px;font-weight:600;margin:2px 0}.num small{font-size:13px;font-weight:400;color:var(--sub)}
ul{margin:6px 0;padding-left:18px}.selo{font-size:12px;font-weight:600;border:1px solid;border-radius:99px;padding:1px 8px;margin-left:4px}
.s-forn{color:var(--forn)}.s-anun{color:var(--anun)}.s-nota{color:var(--nota)}.cont{font-size:14px;color:var(--sub);font-weight:400}
.aviso{border-left:3px solid var(--anun);padding:8px 12px;background:var(--cartao)}.vazio{color:var(--sub)}a{color:inherit}
</style></head><body><main>
<h1>Saúde dos produtos</h1><p class="explica">${esc(r.periodo.nome)} · reclamações da Central de Ocorrências, perguntas do bot e nota dos anúncios no Mercado Livre, juntas por produto.</p>
<div class="totais">
<div>Reclamações<b>${t.reclamacoes}</b><span class="sub">${t.reclamacoesMesAnterior != null ? `mês anterior: ${t.reclamacoesMesAnterior}` : ''}</span></div>
<div>Perguntas<b>${t.perguntas}</b></div>
<div>Nota abaixo de ${t.limiteDaNota != null ? nota1(t.limiteDaNota) : '—'}<b>${t.anunciosComNotaBaixa}</b><span class="sub">anúncios</span></div>
<div>Sem produto<b>${t.semProduto}</b><span class="sub">reclamações fora do relatório</span></div>
</div>
${r.faltou.length ? `<p class="aviso">Faltou: ${r.faltou.map(esc).join(' · ')}</p>` : ''}
${lista('📦 Cobrar o fornecedor', 'Reclamações de defeito, quebra ou peça faltando. Leve os motivos e o que a equipe viu na devolução ao fornecedor.', r.cobrarFornecedor)}
${lista('📝 Corrigir o anúncio', 'Perguntas que se repetem sobre o produto (medida, compatibilidade, o que vem no kit) e reclamações de "diferente do anunciado": falta informação no anúncio.', r.corrigirAnuncio)}
${lista('⭐ Nota baixa', 'Anúncios com a nota abaixo do limite. Veja se a causa aparece nas reclamações acima antes de recriar.', r.notaBaixa)}
${outros.length ? lista('Outras reclamações', 'Produtos com reclamação no mês que ainda não pedem ação.', outros) : ''}
<p class="sub">Gerado em ${esc(new Date(r.geradoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))} pelo Gerente IA.</p>
</main></body></html>`;
}

// ------------------------------------------------------------------ busca nas fontes

async function tentar<T>(fn: () => Promise<T>): Promise<T | { erro: string }> {
  try {
    return await fn();
  } catch (err: any) {
    return { erro: err?.message || String(err) };
  }
}

export async function buscarFontes(periodo: Periodo): Promise<Fontes> {
  const s = sistemas();
  const antes = periodoDoMes(mesAntes(periodo.mes))!;
  const q = (p: Periodo) => `?desde=${p.desde}&ate=${p.ate}`;
  const naoLigado = (rotulo: string, variavel: string) => Promise.resolve({ erro: `${rotulo} não está ligado ao Gerente (falta ${variavel}).` });
  const [reclamacoes, reclamacoesMesAnterior, perguntas, notas, margem] = await Promise.all([
    s.ocorrencias.baseUrl ? tentar(() => chamar('ocorrencias', `/api/admin/saude-produtos${q(periodo)}`, { timeoutMs: 60000 })) : naoLigado('A Central de Ocorrências', 'OCORRENCIAS_BASE_URL'),
    s.ocorrencias.baseUrl ? tentar(() => chamar('ocorrencias', `/api/admin/saude-produtos${q(antes)}`, { timeoutMs: 60000 })) : naoLigado('A Central de Ocorrências', 'OCORRENCIAS_BASE_URL'),
    s.bot.baseUrl ? tentar(() => chamar('bot', `/api/saude-produtos${q(periodo)}`, { timeoutMs: 30000 })) : naoLigado('O bot de perguntas', 'BOT_BASE_URL'),
    tentar(() => chamar('analytics', '/api/ratings', { timeoutMs: 60000 })),
    tentar(() => chamar('analytics', '/api/margem', { timeoutMs: 90000 })),
  ]);
  return { reclamacoes, reclamacoesMesAnterior, perguntas, notas, margem };
}

/** Cache curto: o relatorio de um mes fechado nao muda a cada minuto, e cada geracao varre tres sistemas. */
const cache = new Map<string, { em: number; relatorio: RelatorioSaude }>();
export async function relatorioDoMes(mes: string, forcar = false): Promise<RelatorioSaude> {
  const periodo = periodoDoMes(mes);
  if (!periodo) throw new Error(`Mês inválido: ${mes}. Use AAAA-MM.`);
  const c = cache.get(mes);
  if (!forcar && c && Date.now() - c.em < 30 * 60 * 1000) return c.relatorio;
  const relatorio = montarRelatorio(await buscarFontes(periodo), periodo);
  cache.set(mes, { em: Date.now(), relatorio });
  return relatorio;
}

// ------------------------------------------------------------------ link assinado

/** O link da pagina vai no Telegram: em vez da SERVICE_API_KEY, leva uma assinatura que so abre aquele mes. */
export function assinaturaDoMes(mes: string, segredo = config.serviceApiKey): string {
  return crypto.createHmac('sha256', segredo).update(`saude:${mes}`).digest('hex').slice(0, 24);
}

export function linkDoRelatorio(mes: string): string | undefined {
  if (!config.baseUrl || !config.serviceApiKey) return undefined;
  return `${config.baseUrl}/relatorio/saude/${mes}?t=${assinaturaDoMes(mes)}`;
}

function assinaturaConfere(mes: string, t: unknown): boolean {
  if (!config.serviceApiKey || typeof t !== 'string') return false;
  const a = Buffer.from(assinaturaDoMes(mes));
  const b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ envio mensal

export function deveEnviarRelatorio(agora: Date, dia: number, hora: number, ultimoMesEnviado: string | null): boolean {
  if (hora < 0) return false;
  const b = horaEmBrasilia(agora);
  return Number(b.dia.slice(8, 10)) === dia && b.hora === hora && ultimoMesFechado(agora) !== ultimoMesEnviado;
}

let ultimoMesEnviado: string | null = null;

export async function enviarRelatorio(mes: string): Promise<string> {
  const r = await relatorioDoMes(mes, true);
  const texto = relatorioEmTexto(r, linkDoRelatorio(mes));
  for (const chatId of config.telegramChatIds) await enviar(chatId, texto);
  return texto;
}

async function rodar(agora = new Date()): Promise<void> {
  if (!deveEnviarRelatorio(agora, config.relatorioSaudeDia, config.relatorioSaudeHora, ultimoMesEnviado)) return;
  const mes = ultimoMesFechado(agora);
  ultimoMesEnviado = mes;
  try {
    await enviarRelatorio(mes);
    logger.info(`[SAUDE] Relatório de ${mes} enviado para ${config.telegramChatIds.length} chat(s).`);
  } catch (err: any) {
    logger.warn('[SAUDE] Falha no relatório mensal:', err?.message || err);
  }
}

export function startRelatorioSaude(): void {
  if (config.relatorioSaudeHora < 0) {
    logger.info('[SAUDE] Relatório mensal desligado (RELATORIO_SAUDE_HORA=-1).');
    return;
  }
  if (!config.telegramBotToken || config.telegramChatIds.length === 0) {
    logger.info('[SAUDE] Relatório mensal sem destino (falta TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_IDS).');
    return;
  }
  setInterval(() => void rodar(), 5 * 60 * 1000).unref();
  logger.info(`[SAUDE] Relatório mensal de saúde do produto ligado (dia ${config.relatorioSaudeDia}, ${config.relatorioSaudeHora}h de Brasília).`);
}

// ------------------------------------------------------------------ rotas

export async function saudeProdutoRoutes(app: FastifyInstance): Promise<void> {
  /** Pagina do relatorio. Abre com o link assinado do Telegram (?t=) ou com a SERVICE_API_KEY (?key=). */
  app.get('/relatorio/saude/:mes', async (req, reply) => {
    const { mes } = req.params as { mes: string };
    const { t, key, atualizar } = (req.query ?? {}) as { t?: string; key?: string; atualizar?: string };
    const liberado = assinaturaConfere(mes, t) || (!!config.serviceApiKey && key === config.serviceApiKey);
    if (!liberado) {
      reply.code(401).type('text/plain; charset=utf-8');
      return 'Link inválido ou vencido. Peça o relatório de novo ao Gerente.';
    }
    if (!periodoDoMes(mes)) {
      reply.code(400).type('text/plain; charset=utf-8');
      return 'Mês inválido. Use AAAA-MM.';
    }
    const r = await relatorioDoMes(mes, atualizar === '1');
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return relatorioEmHtml(r);
  });

  /** Diagnostico: JSON do relatorio e o texto do Telegram. ?mes=AAAA-MM (padrao: ultimo mes fechado); &enviar=1 manda agora. */
  app.get('/debug/saude-produtos', async (req) => {
    const q = (req.query ?? {}) as { mes?: string; enviar?: string };
    const mes = q.mes || ultimoMesFechado();
    if (q.enviar === '1') return { enviado: true, texto: await enviarRelatorio(mes) };
    const r = await relatorioDoMes(mes, true);
    return { texto: relatorioEmTexto(r, linkDoRelatorio(mes)), link: linkDoRelatorio(mes), relatorio: r };
  });
}
