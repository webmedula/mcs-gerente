import { describe, expect, it } from 'vitest';
import {
  assinaturaDoMes, categoriaDaReclamacao, deveEnviarRelatorio, mesAntes, montarRelatorio, periodoDoMes, relatorioEmHtml, relatorioEmTexto, ultimoMesFechado,
} from './saudeProduto';
import { requisicaoPermitida } from './sistemas';

const OUT = periodoDoMes('2026-10')!;
const opcoes = { minReclamacoes: 2, minRepetidas: 3 };
const rec = (o: Record<string, unknown>) => ({ protocolo: 'MCS-X', tipo: 'outro', motivoMl: null, conferencia: null, produtos: [], custo: null, ...o });

const fontes = () => ({
  reclamacoes: {
    total: 5,
    ocorrencias: [
      rec({ protocolo: 'P1', tipo: 'defeito', motivoMl: 'O produto tem defeito', conferencia: 'danificado', conferenciaNome: 'Voltou danificado', conferenciaObs: 'lente trincada', custo: 80.5, reputacaoAfetada: true, produtos: [{ itemId: 'MLB1', sku: 'farol-01', titulo: 'Farol de milha' }] }),
      rec({ protocolo: 'P2', tipo: 'outro', motivoMl: 'O produto chegou quebrado', produtos: [{ itemId: 'MLB9', sku: null, titulo: 'Farol de milha (outro anúncio)' }] }),
      rec({ protocolo: 'P3', tipo: 'outro', motivoMl: 'É diferente do anunciado', produtos: [{ itemId: 'MLB2', sku: 'LAMP-02', titulo: 'Lâmpada' }] }),
      rec({ protocolo: 'P4', tipo: 'atraso', produtos: [{ itemId: 'MLB3', sku: 'KIT-03', titulo: 'Kit' }] }),
      rec({ protocolo: 'P5', tipo: 'defeito', produtos: [] }),
    ],
  },
  reclamacoesMesAnterior: { ocorrencias: [rec({ produtos: [{ itemId: 'MLB1', sku: 'FAROL-01' }] })] },
  perguntas: {
    total: 12,
    anuncios: [
      { itemId: 'MLB2', titulo: 'Lâmpada', sku: 'LAMP-02', perguntas: 8, porAssunto: [{ assunto: 'medidas', nome: 'Medidas e especificações', quantidade: 6 }, { assunto: 'frete', nome: 'Frete e prazo de entrega', quantidade: 2 }],
        repetidas: [{ assunto: 'medidas', nome: 'Medidas e especificações', quantidade: 4, exemplos: ['Qual a voltagem?'] }, { assunto: 'frete', nome: 'Frete e prazo de entrega', quantidade: 2, exemplos: ['chega quando?'] }] },
      { itemId: 'MLB4', titulo: 'Capa', sku: null, perguntas: 4, porAssunto: [{ assunto: 'frete', nome: 'Frete', quantidade: 4 }], repetidas: [{ assunto: 'frete', nome: 'Frete', quantidade: 4, exemplos: ['tem frete grátis?'] }] },
    ],
  },
  notas: {
    limite: 4, minOpinioes: 1,
    items: [
      { itemId: 'MLB1', title: 'Farol de milha', nota: 3.6, totalAvaliacoes: 14 },
      { itemId: 'MLB5', title: 'Suporte <script>', nota: 3.2, totalAvaliacoes: 5 },
      { itemId: 'MLB6', title: 'Produto bom', nota: 4.8, totalAvaliacoes: 50 },
    ],
  },
  margem: { anuncios: [{ itemId: 'MLB9', sku: 'FAROL-01', titulo: 'Farol de milha', unidades: 40 }, { itemId: 'MLB1', sku: 'FAROL-01', unidades: 60 }] },
});

describe('saúde do produto', () => {
  it('período, mês anterior e último mês fechado', () => {
    expect(OUT).toEqual({ mes: '2026-10', desde: '2026-10-01', ate: '2026-10-31', nome: 'outubro de 2026' });
    expect(periodoDoMes('2026-02')!.ate).toBe('2026-02-28');
    expect(periodoDoMes('2026-13')).toBeNull();
    expect(mesAntes('2026-01')).toBe('2025-12');
    expect(ultimoMesFechado(new Date('2026-11-01T12:00:00Z'))).toBe('2026-10');
    // 00:30 UTC do dia 1 ainda é dia 31 em Brasília
    expect(ultimoMesFechado(new Date('2026-11-01T00:30:00Z'))).toBe('2026-09');
  });

  it('classifica a reclamação', () => {
    expect(categoriaDaReclamacao({ tipo: 'defeito' })).toBe('qualidade');
    expect(categoriaDaReclamacao({ tipo: 'outro', motivoMl: 'Chegou quebrado' })).toBe('qualidade');
    expect(categoriaDaReclamacao({ tipo: 'troca_devolucao', conferencia: 'incompleto' })).toBe('qualidade');
    expect(categoriaDaReclamacao({ tipo: 'defeito', motivoMl: 'É diferente do anunciado' })).toBe('anuncio');
    expect(categoriaDaReclamacao({ tipo: 'outro', motivoMl: 'Não serve no meu carro' })).toBe('anuncio');
    expect(categoriaDaReclamacao({ tipo: 'nao_recebido' })).toBe('entrega');
    expect(categoriaDaReclamacao({ tipo: 'outro', motivoMl: 'Me arrependi' })).toBe('outros');
  });

  it('junta por SKU (inclusive anúncio sem SKU na reclamação, pela margem) e monta as três listas', () => {
    const r = montarRelatorio(fontes(), OUT, opcoes);
    expect(r.faltou).toEqual([]);
    expect(r.totais).toMatchObject({ reclamacoes: 5, reclamacoesMesAnterior: 1, semProduto: 1, perguntas: 12, anunciosComNotaBaixa: 2, limiteDaNota: 4 });

    const farol = r.produtos.find((p) => p.sku === 'FAROL-01')!;
    expect(farol.anuncios.sort()).toEqual(['MLB1', 'MLB9']);
    expect(farol.unidades30d).toBe(100);
    expect(farol.reclamacoes).toMatchObject({ total: 2, mesAnterior: 1, prejuizo: 80.5, reputacaoAfetada: 1, protocolos: ['P1', 'P2'] });
    expect(farol.reclamacoes.porCategoria.qualidade).toBe(2);
    expect(farol.reclamacoes.observacoes).toEqual(['lente trincada']);
    expect(farol.nota).toMatchObject({ valor: 3.6, anuncio: 'MLB1', abaixoDoLimite: true });
    expect(farol.acoes).toEqual({ cobrarFornecedor: true, corrigirAnuncio: false, notaBaixa: true });
    expect(r.produtos[0].sku).toBe('FAROL-01'); // o mais urgente primeiro

    const lampada = r.produtos.find((p) => p.sku === 'LAMP-02')!;
    expect(lampada.acoes.corrigirAnuncio).toBe(true);
    expect(lampada.perguntas.sobreOProduto).toBe(6);
    expect(lampada.perguntas.repetidas[0]).toMatchObject({ quantidade: 4, sobreOProduto: true, exemplo: 'Qual a voltagem?' });

    // pergunta de frete repetida não pede correção do anúncio
    expect(r.produtos.find((p) => p.anuncios.includes('MLB4'))!.acoes.corrigirAnuncio).toBe(false);
    // anúncio com nota boa e sem nada não entra
    expect(r.produtos.some((p) => p.anuncios.includes('MLB6'))).toBe(false);

    expect(r.cobrarFornecedor.map((p) => p.sku)).toEqual(['FAROL-01']);
    expect(r.corrigirAnuncio.map((p) => p.sku)).toEqual(['LAMP-02']);
    expect(r.notaBaixa.map((p) => p.anuncios[0])).toEqual(['MLB5', 'MLB1']);
  });

  it('fonte fora do ar não derruba o relatório: diz o que faltou', () => {
    const f = { ...fontes(), perguntas: { erro: 'Bot fora do ar' }, notas: { erro: 'ML não autorizado' }, margem: { erro: 'demorou' } };
    // sem a margem, o anúncio MLB9 (sem SKU na reclamação) não se junta ao FAROL-01: cada um fica com 1 reclamação
    const r = montarRelatorio(f, OUT, opcoes);
    expect(r.faltou).toHaveLength(3);
    expect(r.faltou[2]).toContain('cada anúncio aparece separado');
    expect(r.cobrarFornecedor).toHaveLength(0);
    expect(relatorioEmTexto(r)).toContain('Faltou');
  });

  it('texto do Telegram e página', () => {
    const r = montarRelatorio(fontes(), OUT, opcoes);
    const t = relatorioEmTexto(r, 'https://gerente.test/relatorio/saude/2026-10?t=abc');
    expect(t).toContain('Saúde dos produtos — outubro de 2026');
    expect(t).toContain('Reclamações: 5 (mês anterior: 1)');
    expect(t).toContain('Farol de milha (SKU FAROL-01): 2 reclamação(ões) de defeito, quebra ou peça faltando de 100 vendidos em 30 dias (2,0%)');
    expect(t).toContain('4 perguntas iguais sobre medidas e especificações ("Qual a voltagem?")');
    expect(t).toContain('nota 3,6 com 14 opiniões');
    expect(t).toContain('1 reclamação(ões) sem produto identificado');
    expect(t).toContain('Relatório completo: https://gerente.test/');
    expect(t.length).toBeLessThan(4000);

    const html = relatorioEmHtml(r);
    expect(html).toContain('Cobrar o fornecedor');
    expect(html).toContain('Suporte &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('envio mensal só no dia e na hora marcados, uma vez por mês', () => {
    const dia1as9 = new Date('2026-11-01T12:10:00Z'); // 9h10 em Brasília
    expect(deveEnviarRelatorio(dia1as9, 1, 9, null)).toBe(true);
    expect(deveEnviarRelatorio(dia1as9, 1, 9, '2026-10')).toBe(false);
    expect(deveEnviarRelatorio(new Date('2026-11-02T12:10:00Z'), 1, 9, null)).toBe(false);
    expect(deveEnviarRelatorio(dia1as9, 1, -1, null)).toBe(false);
  });

  it('link assinado abre só aquele mês', () => {
    expect(assinaturaDoMes('2026-10', 'k')).toHaveLength(24);
    expect(assinaturaDoMes('2026-10', 'k')).not.toBe(assinaturaDoMes('2026-09', 'k'));
  });

  it('trava de leitura libera só as rotas novas de leitura', () => {
    expect(requisicaoPermitida('ocorrencias', 'GET', '/api/admin/saude-produtos?desde=2026-10-01&ate=2026-10-31')).toBe(true);
    expect(requisicaoPermitida('bot', 'GET', '/api/saude-produtos?desde=2026-10-01')).toBe(true);
    expect(requisicaoPermitida('bot', 'GET', '/api/estado')).toBe(true);
    expect(requisicaoPermitida('bot', 'GET', '/api/perguntas')).toBe(false);
    expect(requisicaoPermitida('bot', 'POST', '/api/perguntas/1/responder')).toBe(false);
  });
});
