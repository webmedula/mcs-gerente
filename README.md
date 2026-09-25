# mcs-gerente — v1 (2026-09-24)

O **Gerente** é o assistente de IA da MCS no Telegram. Ele consulta os **três sistemas** da
operação pelas APIs de cada um, sem acessar banco de ninguém:

| Sistema | O que o Gerente consulta |
|---|---|
| **ml-analytics** (v34+) | resumo, top anúncios, margem, reposição, notas, Buy Box, lacunas de custo, SQL, histórico — as ferramentas vêm do próprio analytics |
| **ml-actions** | fila de candidatos à recriação, histórico de recriações, diagnóstico de formato |
| **tiny-pedidos-nf** | pedidos pendentes, prévia do desconto, processados/erros, lotes, vendas do dia, painel, listas de preço |
| geral | `estado_dos_sistemas`: saúde, versões, logins ML/Tiny, agendador de notas |

## v1 = somente leitura

A trava está no código (`src/sistemas.ts`), não no comportamento do modelo:

- GET em `/api/*` e `/health` dos três sistemas;
- POST **só** em `/api/assistente/ferramenta/:nome` do ml-analytics (ferramentas de leitura);
- qualquer outra coisa é recusada antes de sair do Gerente. Os testes em `src/sistemas.test.ts`
  listam todas as rotas de escrita conhecidas e confirmam que estão bloqueadas.

Fase 2 (futura): ações com confirmação no Telegram, entrando por lista explícita de rotas.

## Requisito

O **ml-analytics precisa estar na v34 ou superior** (rota `/api/assistente/*`). Sem ela o Gerente
funciona com ml-actions e tiny-pedidos-nf e avisa que as ferramentas do analytics estão fora.

## Deploy (EasyPanel) — mesmo padrão dos outros serviços

1. Suba este repositório como `webmedula/mcs-gerente`. O push na `main` publica
   `ghcr.io/webmedula/mcs-gerente:latest` (workflow em `.github/workflows/main.yml`).
2. No EasyPanel, crie o serviço **mcs-gerente** no mesmo projeto, com essa imagem, porta **3020**
   e domínio próprio. Não precisa de volume (o Gerente não guarda dados).
3. Variáveis: ver `.env.example`. As do assistente e do Telegram são **as mesmas** que estão hoje
   no ml-analytics. As chaves `*_API_KEY` são a `SERVICE_API_KEY` de cada sistema.
4. Confira `https://SEU-GERENTE/debug/sistemas?key=SUA_SERVICE_API_KEY` — os três devem dar `ok: true`.
5. Confira `https://SEU-GERENTE/debug/assistente?key=...` — provedor, modelo e ferramentas por sistema.
6. Teste sem Telegram: `https://SEU-GERENTE/debug/perguntar?key=...&q=quanto+vendemos+ontem`.

## Virada do bot (troca de webhook)

O bot é o mesmo; só muda para onde o Telegram entrega as mensagens.

1. Abra `https://SEU-GERENTE/debug/telegram/registrar?key=...` — o webhook passa a apontar pro Gerente.
2. Mande `/start` no Telegram: a resposta deve dizer **"Gerente da MCS (gerente v1 ...)"**.
3. **Voltar atrás**, se precisar: abra `/debug/telegram/registrar?key=...` no **ml-analytics** —
   ele continua com o bot antigo na v34.
4. Com o Gerente estável, a rota do Telegram sai do ml-analytics numa versão seguinte.

## Rotas

- `GET /health` — aberta: versão e se cada sistema está configurado (sem expor URL nem chave).
- `POST /telegram/webhook/:segredo` — webhook do Telegram.
- `GET /debug/sistemas` · `/debug/assistente` · `/debug/perguntar?q=` · `/debug/telegram/registrar` — exigem chave.

## Desenvolvimento

```bash
npm install
npm test        # 24 testes, sem chamar nenhum sistema real
npm run dev
```

## Histórico de versões

- **v1 (2026-09-24)** — primeira versão. Bot migrado do ml-analytics v33, agora consultando os três
  sistemas; somente leitura; ferramentas do analytics buscadas em tempo de execução; chamadas de um
  mesmo passo em paralelo; data de hoje (Brasília) no contexto do modelo; resultado grande cortado
  com aviso; `/debug/sistemas` para testar conexão e chaves.
