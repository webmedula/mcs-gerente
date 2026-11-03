# mcs-gerente — v1.2 (2026-11-03)

> **v1.2:** **aviso diário de promoções do ML.** Todo dia às 9h (Brasília) o Gerente pergunta ao
> ml-analytics (v35+, ferramenta `promocoes_do_ml`) quais propostas de promoção do Mercado Livre
> apareceram nas últimas 24h e manda a lista pronta para os chats de `TELEGRAM_CHAT_IDS`. Sem
> proposta nova, não manda nada. Não passa pela IA (texto pronto, sem custo de token).
> `AVISO_PROMOCOES_HORA` muda a hora (0–23) ou desliga (`-1`). Para testar:
> `GET /debug/aviso-promocoes?key=SUA_SERVICE_API_KEY` mostra o texto; com `&enviar=1` manda agora.


O **Gerente** é o assistente de IA da MCS no Telegram. Ele consulta os **quatro sistemas** da
operação pelas APIs de cada um, sem acessar banco de ninguém:

| Sistema | O que o Gerente consulta |
|---|---|
| **ml-analytics** (v34+) | resumo, top anúncios, margem, reposição, notas, Buy Box, lacunas de custo, SQL, histórico, promoções do ML (v35+) — as ferramentas vêm do próprio analytics |
| **ml-actions** | fila de candidatos à recriação, histórico de recriações, diagnóstico de formato |
| **tiny-pedidos-nf** | pedidos pendentes, prévia do desconto, processados/erros, lotes, vendas do dia, painel, listas de preço |
| **Central de Ocorrências** (mcs-ocorrencias) | lista de ocorrências por status/canal/responsável, detalhe de um protocolo (histórico, mensagens do ML, devolução, conta da venda), números do período e fila de devoluções |
| geral | `estado_dos_sistemas`: saúde, versões, logins ML/Tiny, agendador de notas |

## v1 = somente leitura

A trava está no código (`src/sistemas.ts`), não no comportamento do modelo:

- GET em `/api/*` e `/health` do ml-analytics, ml-actions e tiny-pedidos-nf;
- POST **só** em `/api/assistente/ferramenta/:nome` do ml-analytics (ferramentas de leitura);
- na Central de Ocorrências, só os GET de uma lista fechada (lista, detalhe, devoluções, números,
  modelos): backup, CSV, anexos, equipe e chaves nem saem do Gerente;
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
   Para a Central de Ocorrências, a chave **não** é a `SERVICE_API_KEY`: crie uma chave do Gerente IA
   no painel da Central (só o gerente vê essa tela), e coloque em `OCORRENCIAS_API_KEY` junto com
   `OCORRENCIAS_BASE_URL`. Sem elas o Gerente funciona normalmente, só sem ocorrências.
4. Confira `https://SEU-GERENTE/debug/sistemas?key=SUA_SERVICE_API_KEY` — os quatro devem dar `ok: true`.
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
npm test        # 30 testes, sem chamar nenhum sistema real
npm run dev
```

## Histórico de versões

- **v1.1 (2026-11-03)** — Central de Ocorrências como quarto sistema, somente leitura: ferramentas
  `ocorrencias_lista`, `ocorrencias_detalhe`, `ocorrencias_numeros` e `ocorrencias_devolucoes`; chave
  enviada como Bearer; lista fechada de rotas GET; e-mail, telefone e dados crus do Tiny não vão pro
  modelo; a Central entra no `estado_dos_sistemas`, no `/debug/sistemas` e no diagnóstico.
- **v1 (2026-09-24)** — primeira versão. Bot migrado do ml-analytics v33, agora consultando os três
  sistemas; somente leitura; ferramentas do analytics buscadas em tempo de execução; chamadas de um
  mesmo passo em paralelo; data de hoje (Brasília) no contexto do modelo; resultado grande cortado
  com aviso; `/debug/sistemas` para testar conexão e chaves.
