# 04 — Módulos entregues (specs 000–017, 042–043)

Cada bloco diz o que a spec entrega, onde isso mora no código, como exercitar e o que ficou
de fora por decisão. A spec em `specs/` continua sendo a fonte de verdade do comportamento;
aqui é o mapa.

| Spec | Entrega | PR | Estado |
|---|---|---|---|
| 000 | Escopo da POC | — | ✅ |
| 001 | Fundação do monorepo, CI mínima, fronteiras | — | ✅ |
| 002 | ERP mock atrás de views canônicas | — | ✅ (domínio trocado pela 012) |
| 003 | Catálogo de queries | — | ✅ |
| 004 | Gateway WhatsApp + simulador | — | ✅ |
| 005 | Runtime do agente (LangGraph) | — | ✅ |
| 006 | Guardrails | — | ✅ |
| 007 | CRM + console HITL | — | ✅ (console refeito em 09/2026) |
| 008 | RAG (base de conhecimento) | — | ✅ (embeddings reais ficam para a 019) |
| 009 | Skills + loop de aprendizado | — | ✅ |
| 010 | Observabilidade | — | ✅ |
| 011 | Deploy no homelab + roteiro | #39 | ✅ (homelab desatualizado — P-21) |
| 012 | Domínio de multipropriedade | #50 | ✅ |
| #45/#46/#47 | Console WhatsApp Web, fusão de turno, HITL na fila | #59 | ✅ |
| 013 | Disparos de template para a carteira | #59 | ✅ |
| 014 | Compra e cobrança pelo WhatsApp | #59 | ✅ (PSP real no sandbox pela 042) |
| 015 / 015a | SDR para lead frio: dados + núcleo | #60, #64 | ✅ núcleo · 015b/015c faltam |
| 016 | Anonimização do que sai para a LLM | #61 | ✅ |
| M2 (P-28..P-33) | Blindagem para exposição | #64 | ✅ |
| Console redesenhado | Design "Console SETA" em todas as telas | #64 | ✅ |
| 017 | Relatório analítico de campanhas | #63 | ✅ |
| 042 | Asaas de verdade no sandbox | #20 | ✅ |
| 043 | Template de pagamento com PIX (order_details) | #21 | ✅ |

## 000 — Escopo da POC
- **Entrega:** define a demo vendável: WhatsApp real, ERP mockado, HITL, skills com
  aprovação. "Não é o produto; é a prova da arquitetura dele."
- **Onde está:** `specs/000-escopo-poc.md`, `specs/README.md` (grafo de dependências).
- **Ficou de fora:** cortes deliberados que voltaram depois (templates reais na 013, cobrança
  na 014) ou continuam fora (mídia, multi-instância).

## 001 — Fundação
- **Entrega:** monorepo pnpm com esqueleto de todos os módulos, `pnpm dev` com um comando,
  CI, Biome, dependency-cruiser com regras provadas por teste.
- **Onde está:** raiz (`package.json`, `tsconfig*`, `biome.json`, `.dependency-cruiser.cjs`),
  `tools/boundaries.spec.ts`, `.github/workflows/ci.yml`.
- **Como exercitar:** `pnpm lint` (inclui depcruise) e `pnpm test tools/`.

## 002 — ERP mock
- **Entrega:** banco `erp_mock` que faz o papel do TS Explorer atrás da mesma fronteira do
  produto real: usuário `erp_ro` só enxerga views canônicas.
- **Onde está:** `infra/erp-mock/{01-tabelas,02-views,03-grants}.sql`, `seed.ts`;
  `packages/domain-erp` (tipos); `packages/erp-connector` (port + `pg`).
- **Como exercitar:** `pnpm db:seed:erp`; `packages/erp-connector/test/pg-connector.integration.test.ts`.
- **Ficou de fora:** o domínio original (distribuidora) foi substituído pela 012.

## 003 — Catálogo de queries
- **Entrega:** única via de acesso a dado estruturado. YAML por query (id, versão,
  descrição para a LLM, entidades, módulos, params com `source: llm|session`, SQL com binds
  nomeados, limites, `output.columns` whitelist, masking, `tool.expose`). Loader valida tudo
  no boot; executor aplica timeout, `max_rows` e masking; `buildToolSpecs` gera as tools.
- **Onde está:** `packages/query-catalog`, `catalog/**`, `apps/server/src/query-event-sink.ts`.
- **Como exercitar:** `packages/query-catalog/test/*` (fixtures válidas e inválidas);
  `catalog/financeiro/titulos_atraso.yaml` é o exemplo canônico.
- **Ficou de fora:** política completa de masking (só `cnpj` existe; a 018 fecha).

## 004 — Gateway WhatsApp + simulador
- **Entrega:** webhook Meta (verificação GET, HMAC no POST, 200 sempre exceto assinatura
  inválida), envio pela Cloud API, gateway de log para dev, simulador (`/simulador`,
  `POST /dev/inbound`, `GET /dev/events`), debounce de turno com janela adaptativa, outbox
  com retry e sweeper de órfãs.
- **Onde está:** `packages/wa-meta`, `apps/server/src/wa/{routes,inbound,debounce,outbox,dev-routes}.ts`,
  `apps/console/app/simulador`.
- **Como exercitar:** `wa.integration.test.ts`, `janela-adaptativa.test.ts`; `docs/meta-setup.md`
  para o número de teste; `pnpm dev-whatsapp` para conversar de verdade.
- **Ficou de fora:** templates (voltaram na 013), mídia (033).

## 005 — Runtime do agente
- **Entrega:** grafo LangGraph do turno com contexto (resumo rolante, histórico, skills, KB,
  tools do catálogo), orçamento de tool calls, timeout, trace completo e provedor trocável;
  sem LLM configurada responde o fallback honesto.
- **Onde está:** `packages/agent`, `packages/ai-provider`, `apps/server/src/wa/turno-handler.ts`.
- **Como exercitar:** `agente.integration.test.ts`; `packages/agent/test/graph.test.ts`.
- **Ficou de fora:** LLM on-prem (025), embeddings (019).

## 006 — Guardrails
- **Entrega:** políticas por arquitetura: hooks `beforeTool`/`afterTool`/`beforeReply` com
  verdicts (`allow`, `rewrite`, `block`, `escalate`); classificador de intenção antes do
  agente (desconto, tema sensível, pedido de humano, interesse de compra…); guardrail de
  preço (todo valor no rascunho precisa rastrear a uma tool); temas sensíveis por
  `client.yaml`.
- **Onde está:** `packages/guardrails`, `configs/demo/client.yaml › guardrails`.
- **Como exercitar:** `packages/guardrails/test/guardrails.test.ts` (inclui a alçada do SDR e
  o teste "LACUNA" do percentual por extenso), `guardrails.integration.test.ts`.
- **Ficou de fora:** percentual por extenso na raia SDR (015c).

## 007 — CRM + console HITL
- **Entrega:** ticket por conversa com máquina de estados (`bot_ativo`,
  `aguardando_humano`, `humano_ativo`, `resolvido`), Better Auth com papéis, console para
  assumir, responder e devolver. Evoluído por #45 (tela estilo WhatsApp Web, nome do
  atendente na mensagem), #46 (fusão de turno) e #47 (bot atende enquanto aguarda humano).
- **Onde está:** `packages/crm`, `apps/server/src/wa/tickets.ts`, `console-routes.ts`,
  `apps/console/app/(console)/inbox`.
- **Como exercitar:** `hitl.integration.test.ts`, `hitl-fila.integration.test.ts`,
  `turno-fusao.integration.test.ts`, `console-atendimento.integration.test.ts`.
- **Ficou de fora:** gestão de usuários pela interface (032).

## 008 — RAG
- **Entrega:** port `VectorStore` com pgvector, chunking de Markdown, busca híbrida (denso +
  lexical com RRF), namespaces `kb` e `skills`, tool `buscar_conhecimento`, `pnpm kb:ingest`.
- **Onde está:** `packages/rag`, `apps/server/src/rag`, `apps/server/src/kb-ingest.ts`, `kb/`.
- **Como exercitar:** `rag.integration.test.ts`; `pnpm kb:ingest`.
- **Ficou de fora:** embeddings reais (`EMBEDDING_MODEL` vazio com a Anthropic ⇒ busca
  lexical) — spec 019.

## 009 — Skills e aprendizado
- **Entrega:** sinais de produção (correções, verdicts, escaladas, feedback do console) →
  propostas geradas por LLM → aprovação humana → skill versionada indexada no retrieval;
  desativar e rollback; `caso_eval` como evidência; job diário de sinais.
- **Onde está:** `packages/skills`, `apps/server/src/skills`, `aprendizado-routes.ts`,
  `apps/console/app/(console)/aprendizado`, `skills-seed/`.
- **Como exercitar:** `aprendizado.integration.test.ts`; Console › Aprendizado › Curadoria › Gerar.

## 010 — Observabilidade
- **Entrega:** `trace_turno` por turno (contexto, tools, verdicts, resposta, tokens,
  latência), `evento_llm`, `evento_guardrail`, `evento_escalonamento`, `evento_query`;
  `/api/console/metricas` com buckets no fuso do cliente; trace viewer no console.
- **Onde está:** `apps/server/src/{obs-emitter,query-event-sink}.ts`, `console-routes.ts`
  (`/metricas`, `/ticket/:id/traces`), `apps/console/app/(console)/aprendizado` (explorador).
- **Como exercitar:** `observabilidade.integration.test.ts`, `query-event-sink.integration.test.ts`.

## 011 — Deploy no homelab + roteiro
- **Entrega:** imagens no GHCR, `compose.prod.yml`, `deploy.sh`, Caddy, seed de demo,
  roteiro de cinco atos.
- **Onde está:** `infra/`, `.github/workflows/release.yml`, `docs/deploy-homelab.md`,
  `docs/roteiro-demo.md`.
- **Estado:** o homelab roda a versão de agosto (P-21 no roadmap).

## 012 — Domínio de multipropriedade
- **Entrega:** troca a camada de domínio inteira pela estrutura real do TS Explorer
  levantada do espelho: 7 views canônicas (`v_cotista`, `v_contrato_cota`, `v_titulo`,
  `v_inadimplencia`, `v_cancelamento`, `v_chamado`, `v_cota_disponivel`), catálogo, persona,
  KB e skills-seed no vocabulário de cota, período, tier e distrato. `v_cotista` não expõe
  nome nem CPF.
- **Onde está:** `infra/erp-mock`, `packages/domain-erp`, `catalog/`, `kb/`, `configs/demo`.
- **Como exercitar:** roteiro Ato 1; `agente.integration.test.ts`.
- **Ficou de fora:** reservas, calendário e check-in não existem no ERP — o agente admite
  que não sabe e escala.

## 013 — Disparos de template para a carteira
- **Entrega:** modelos criados da plataforma e registrados na Meta (`TemplateApi`), sync de
  aprovação, disparo para contatos da carteira com worker, status por destinatário via
  webhook, mensagem `campanha` na conversa; no console vira "Campanhas" (wizard de 3 passos,
  detalhe com funil).
- **Onde está:** `packages/wa-meta/template.ts`, `apps/server/src/disparos-routes.ts`,
  `wa/disparo.ts`, `apps/console/app/(console)/campanhas`.
- **Como exercitar:** `disparos.integration.test.ts`; precisa de `WA_WABA_ID` para modelos reais.
- **Ficou de fora:** segmentação, agendamento, variável por destinatário, mídia/botões,
  opt-out, webhook de status de template (030).

## 014 — Compra e cobrança pelo WhatsApp
- **Entrega:** "quero pagar" → lista de parcelas → método (boleto, PIX, cartão) →
  confirmação → emissão no PSP → envio → webhook → baixa em `pagamento` e conciliação nas
  leituras do ERP; teto com aprovação humana; limite por conversa por dia; console de
  cobranças com aprovar, recusar e simular pagamento; ADR 0001.
- **Onde está:** `packages/cobranca`, `packages/payment-provider`,
  `apps/server/src/pagamentos`, `apps/console/app/(console)/cobrancas`, `docs/asaas-setup.md`.
- **Como exercitar:** `cobranca.integration.test.ts` (9 cenários), roteiro Ato 5.
- **Ficou de fora:** dados de cartão (nunca), baixa no ERP real, régua proativa,
  negociação. Produção do Asaas depende da decisão D1 (027).

## 015 / 015a — SDR para lead frio
- **Entrega:** dados (`tabelapreco`, `v_cota_disponivel`, alçada de 3% provada no
  guardrail); núcleo: máquina `qualificacao → apresentacao → oferta → agendamento →
  encerrado`, parser determinístico com LLM de fallback, migração 0015 (`lead`, `fluxo_sdr`,
  `proposta_sdr`), catálogo `comercial/` com `price_source`, `comprar_cota` sem vínculo inicia
  o fluxo, trigger `desconto_acima_alcada`, `personaSdr`; console › Leads (leitura).
- **Onde está:** `packages/sdr`, `apps/server/src/sdr`, `catalog/comercial`,
  `apps/console/app/(console)/leads`.
- **Como exercitar:** `sdr.integration.test.ts`, `packages/sdr/test/sdr.test.ts`.
- **Ficou de fora:** aprovar/recusar no console (015b), percentual por extenso (015c),
  prospecção ativa e raia do cotista (031).

## 016 — Anonimização
- **Entrega:** decorator do `AIProvider` que troca PII do texto livre por tokens estáveis
  (regex validado, dicionário de contexto, NER local com ONNX) e restaura na resposta;
  evento `anonimizacao` no trace com contagens; modelo embarcado na imagem.
- **Onde está:** `packages/anonimizacao`, `apps/server/src/anonimizacao.ts`,
  `infra/docker/server.Dockerfile`.
- **Como exercitar:** `anonimizacao.integration.test.ts`, `packages/anonimizacao/test/*`
  (`pnpm anonimizacao:modelo` para os testes de NER).
- **Ficou de fora:** o que fica no nosso banco (retenção — 024), LLM on-prem (025).

## M2 — Blindagem para exposição (P-28..P-33)
- **Entrega:** boot em `production` recusa defaults de dev; senhas do Postgres fora do
  compose; `release.yml` só publica com CI verde; `.env.example` completo; `kb:ingest` remove
  documento órfão; índice HNSW em migração; `/` redireciona para `/inbox`; stubs removidos.
- **Onde está:** `apps/server/src/env.ts`, `infra/compose.prod.yml`, `.github/workflows/release.yml`.
- **Como exercitar:** `env.test.ts`.

## Console redesenhado (design "Console SETA")
- **Entrega:** todas as telas no design aprovado no Claude Design: Atendimento (3 colunas +
  contexto do cotista), Campanhas, Cobranças (drawer), Leads (drawer), Aprendizado
  (explorador + curadoria), Métricas, Configurações, simulador; tokens em `globals.css`;
  componentes em `components/ui`; endpoints novos (`instalacao`, `resumo`, `equipe`,
  `conversas`, `conversa/:id`, `traces/:id/feedback`). Correção da raiz tipográfica (o
  `html` em 14px encolhia toda a escala em 12,5%).
- **Como exercitar:** `console-shell.integration.test.ts`; screenshots por CDP (ver 06).

## 017 — Relatório analítico de campanhas
- **Entrega:** `GET /api/console/relatorios/campanhas` (funil até "pagas" por campanha,
  atribuição por janela e "última campanha leva o crédito", período anterior, opções),
  meta de conversão global (`client.yaml`) e por campanha (`disparo.meta_conversao_bps`),
  `disparo.nome`; aba em Métricas com filtros na URL, KPIs, funil, por competência, por
  modelo, tabela, insights, CSV e impressão.
- **Onde está:** `apps/server/src/relatorios-routes.ts`, `apps/console/app/(console)/metricas/relatorio-campanhas.tsx`,
  `apps/console/lib/relatorio.ts`, `components/ui/funil.tsx`.
- **Como exercitar:** `relatorio-campanhas.integration.test.ts`, `apps/console/test/relatorio.test.ts`.
- **Ficou de fora:** opt-outs, envio automático, competência financeira, relatórios de
  cobrança e atendimento (030).

## 042 — Asaas de verdade no sandbox
- **Entrega:** o PSP deixa de ser simulado — cobrança emitida, paga e conciliada contra a
  API real do Asaas (validado em 15/09/2026: `pay_yjpuup1ic7tn42tb`, dois webhooks pelo
  túnel, baixa e conciliação). Reprocesso de evento do PSP preso
  (`GET /api/console/eventos-psp?pendente=true`, `POST …/:id/reprocessar` com guarda de
  concorrência em SQL), contagem de pendentes e painel no console; `simular-pagamento`
  passa a exigir ambiente diferente de produção, não só `DEV_SIMULATOR`.
- **Onde está:** `apps/server/src/pagamentos/eventos-routes.ts` (novo),
  `pagamentos/eventos.ts` (`reenfileirarEventoPsp`, `concluir(..., terminal)`),
  `pagamentos/cobrancas-routes.ts` (`simuladorAtivo`, `eventosPspPendentes`),
  `apps/console/app/(console)/cobrancas/eventos-psp.tsx` (novo) e `page.tsx`,
  `apps/console/lib/console-api.ts`.
- **Como exercitar:** `asaas-sandbox.integration.test.ts` (ciclo real com `fetchFn` fake
  roteado, reaproveitamento por referência, 401/reentrega, 404 em produção) e os dois casos
  `042:` em `cobranca.integration.test.ts`. Contra o Asaas de verdade:
  `pnpm dev-whatsapp` + `docs/asaas-setup.md`.
- **Ficou de fora:** produção e chave de produção (027), estorno ativo pela plataforma,
  eventos fora dos sete assinados, baixa no ERP (036), template de PIX no WhatsApp (043).

## 043 — Template de pagamento com PIX (order_details)
- **Entrega:** o WhatsApp manda a cobrança fora da janela de 24 h. O template aprovado usa
  `ORDER_DETAILS` (WhatsApp Pay BR): link no corpo, e no botão um pedido com o copia-e-cola
  do Asaas, `total_amount` e um item por título. Validado no aparelho em 15/09/2026 — o botão
  abre o pagamento com valor e recebedor corretos. Também fecha os dois ramos do aviso de
  "pagamento confirmado", que não tinham teste nenhum.
- **Onde está:** `packages/wa-meta/src/order-details.ts` (novo, schema + builder do botão),
  `template.ts` (`OutboundTemplate.botao`, `payloadDeTemplate`), `gateway.ts` (log),
  `apps/server/src/pagamentos/order-details.ts` (novo, montador),
  `apps/server/src/wa/outbox.ts` (coluna `template` + reengajamento no ramo de janela
  fechada), `emitir.ts`, `packages/client-config` (`pagamentos.pix`), migração `0017`.
- **Como exercitar:** `packages/wa-meta/test/template.test.ts` (payload literal + regressão
  byte a byte), `apps/server/test/order-details.test.ts`, os casos `043:` em
  `cobranca.integration.test.ts` e `wa.integration.test.ts`. Contra a Meta:
  `docs/meta-setup.md` §7.
- **Ficou de fora:** header de mídia (033); cadastrar template com botão pela plataforma e
  trazer `components` do remoto (023); variável por destinatário e opt-out (044); dinheiro
  de verdade (027).

## 035 — Simulador da API do TS Explorer (`apps/tse-sim`)
- **Entrega:** o ERP simulado ganha a segunda superfície — uma API HTTP que responde **como o
  fornecedor** (OAuth2 `password` no `/token`, PascalCase, datas com `-03:00`) sobre o **mesmo**
  `erp_mock` que o produto lê por SQL. E que **escreve**: `POST financeiro/TransacaoEletronica`
  grava `contafinanceira.datarecebimento` e a parcela aparece `pago` em `v_titulo` na leitura
  seguinte — é o que a 036 usa para enterrar a conciliação fingida da 014. São **30 das 89**
  rotas da coleção: `/token`, `PainelDoCliente/{MeusContratos, MeusDadosCadastrais,
  FinanceiroContrato, MeusBoletos, ObterTaxasDPNU}`, `utilizacaocontrato/obtercontratos`,
  `cadastros/{GetPessoa, GetPessoaCpf}`, os 17 `Lookup/*` e as três escritas de `financeiro/*`.
- **O contrato veio da coleção Postman do fornecedor**, sanitizada e commitada
  (`apps/tse-sim/contrato/`): `pnpm tse:fixtures` confere o `sha256` do original, troca tokens,
  e-mails, CPFs e telefones por versões fictícias e extrai os 89 exemplos de resposta. Sem
  ambiente do TSE, essa coleção **é** o contrato — e o teste compara **forma**, não valor.
- **Onde está:** `apps/tse-sim/` (workspace novo: `app.ts`, `auth.ts`, `db.ts`, `pascal.ts`,
  `plugin-bearer.ts`, `rotas/`), `tools/tse-fixtures.ts`, `infra/erp-mock/{04-sim-role,
  05-sim-schema,06-sim-sequences}.sql`, `infra/erp-mock/seed.ts` (senha por bind e
  ressincronização das sequências), `infra/docker/tse-sim.Dockerfile`, `infra/compose.prod.yml`,
  `.github/workflows/release.yml`.
- **Fronteira nova:** terceiro papel no `erp_mock`. `tse_sim` escreve nas tabelas físicas e é
  **cego para as 7 views canônicas** — quem lê o ERP pelo produto continua sendo o `erp_ro`, e as
  duas superfícies não se misturam (`escrita.integration.test.ts` prova os dois lados).
- **Como exercitar:** `pnpm dev` sobe o simulador em `:3010`; receitas em
  `docs/tse-api-setup.md` §7. Testes: `contrato.test.ts` (30 rotas contra as fixtures +
  procedência da sanitização), `escrita.integration.test.ts` (a baixa chega ao `v_titulo`; o
  `INSERT` sem id funciona depois de um seed com id explícito), `divergencias.integration.test.ts`
  (o `/token` salvo como GET com body; **D10** nos dois modos de escopo) e `env.test.ts`.
- **No homelab:** o serviço sobe com a demo, **sem porta publicada e sem rota no Caddy** — só o
  server o alcança, em `http://tse-sim:3010`. Ver `docs/deploy-homelab.md`.
- **Ficou de fora:** o adapter HTTP e qualquer mudança no `apps/server` (036/037), reserva (038),
  lead e venda (039), 2ª via em PDF (040), o TSE real (041) e as 59 rotas ainda não respondidas
  (placar em `apps/tse-sim/test/pendentes.ts`). `OperadorSistema/*` e `Relatorios/*` não têm dono:
  nenhuma jornada da demo as usa.

## 036 — Escrita no ERP (`ErpWriter`) e baixa real do pagamento
- **Entrega:** a conciliação deixa de ser ficção e vira ponte. O cotista paga, o webhook do Asaas
  chega, e a baixa é **gravada no TSE** por `POST financeiro/TransacaoEletronica`; como a leitura
  continua por SQL **sobre a mesma base**, a parcela aparece `v_titulo.status = 'pago'` na leitura
  seguinte — sem esperar a 037. O decorator da 014 passa a compensar **só o que ainda está em voo**
  (`ERP_CONCILIACAO=auto`), então em nenhum instante há contagem dupla.
- **A descoberta que mudou a spec:** *não existe endpoint de baixa para PIX ou boleto*.
  `TransacaoEletronica` é o único caminho das 90 rotas e o corpo dele é de cartão; nenhum request da
  coleção tem campo de pagamento/recebimento/liquidação. Entregue sob **premissa registrada** —
  campos de cartão nulos, id do PSP em `CodigoAutorizacao` — em `docs/tse-api-setup.md` §4b.
- **Onde está:** `packages/erp-api-tse` (novo: `tipos`, `erros`, `token`, `http`, `cliente`,
  `simulado`), `apps/server/src/erp/baixa.ts` (novo), `pagamentos/eventos.ts` (`marcarPaga` grava a
  intenção na MESMA transação), `pagamentos/repo.ts` (`ModoConciliacao`), `db/schema.ts`
  (`erp_escrita`), migração `0018`, `boss.ts` (`FILA_ERP_BAIXA`), `env.ts`, `index.ts`,
  `.dependency-cruiser.cjs` (duas regras novas) e `infra/compose.prod.yml`.
- **Idempotência em quatro camadas**, porque o webhook reentrega e o pg-boss re-tenta:
  `erp_escrita.chave` é PK (guarda antes) · **read-back** antes de repetir o POST (a única defesa
  real: o TSE não é idempotente) · `CodigoAutorizacao` com o id do PSP (rastro no próprio ERP) ·
  retry limitado, com `ErpAuthError`/`ErpBusinessError` indo direto para humano.
- **Como exercitar:** `packages/erp-api-tse/test/` (21 casos contra as fixtures do fornecedor, sem
  rede) e `apps/server/test/erp-baixa.integration.test.ts` (12 casos contra o simulador da 035 **de
  verdade**: o `fetchFn` entra no Fastify do `apps/tse-sim` por `inject`). O efeito é conferido em
  `contafinanceira` e em `v_titulo`, lido pelo papel do PRODUTO (`erp_ro`).
- **Ficou de fora:** catálogo por HTTP (037 — as leituras continuam por SQL, de propósito), reserva
  (038), lead e venda (039), 2ª via (040), apagar `conciliacao.ts` e apontar para o TSE real (041).

## 038 — Reserva de utilização de contrato pelo agente
- **Entrega:** o ato mais honesto da demo virou o mais forte. Até aqui o agente dizia que
  "reservas são com a central" — verdade, porque o espelho SQL do TS Explorer não tem reserva
  (012). A API tem: o cotista pede a semana, o agente pergunta o que falta, **simula pontos e taxa
  no ERP diária a diária**, pede confirmação e **cria a utilização**, que passa a existir em
  `MinhasUtilizacoesContrato` com o nome do operador que pediu.
- **Onde está:** `packages/reserva` (novo, domínio puro), `packages/erp-api-tse/src/reserva.ts`,
  `apps/tse-sim/src/rotas/utilizacao-contrato.ts` (+14 rotas), `apps/server/src/reserva/`
  (`fluxo`, `worker`, `repo`, `tools`, `escalar`, `reservas-routes`), migração `0019`,
  `apps/console/app/(console)/reservas/`, e a aba Reservas no painel de contexto do `/inbox`.
- **A escrita é DUAS chamadas, não 1+N:** `CriarUtilizacaoContrato` aceita `ListaHospedes` inline,
  então criar+hóspedes é uma coisa só. Depois vem `ConfirmarUtilizacaoContrato/{id}`.
- **Idempotência sem referência externa.** A 036 pôde carimbar o id do PSP em `CodigoAutorizacao`;
  aqui **não existe campo equivalente**. O reconhecimento é por **chave natural** (semana, hotel,
  tipo de UH, lotação), o `erp_utilizacao_id` é gravado num UPDATE isolado logo após criar, e um
  índice único parcial em `reserva` impede duas conversas na mesma semana. Falha definitiva escala
  e **nunca cancela sozinha**: se a confirmação pegou, cancelar destruiria uma reserva real.
- **O CPF não passa pelo modelo.** O hóspede principal é o titular, com o CPF que a plataforma já
  tinha (014); os demais saem do parser determinístico sobre o texto cru, com DV conferido. O
  schema do fallback por LLM **não tem campo onde caiba um CPF** — não é convenção, é a defesa.
- **A simulação acontece antes de pedir hóspedes**, de propósito: quem não tem pontos ou pegou
  período bloqueado descobre isso sem ter entregado nenhum dado pessoal.
- **Persona:** as seis afirmações de que "reserva é com a central" mudaram juntas (persona,
  personaSdr, descrição do catálogo, duas páginas da KB e o prompt-base). **A KB só muda de
  verdade depois de `pnpm kb:ingest`** — com o índice velho o agente cita o texto antigo.
- **Como exercitar:** `packages/reserva/test/reserva.test.ts` (33 casos puros),
  `packages/erp-api-tse/test/reserva.test.ts` (adapter contra as fixtures) e
  `apps/server/test/reserva.integration.test.ts` (15 casos contra o simulador da 035, incluindo o
  read-back que adota a utilização quando a resposta se perde).
- **Ficou de fora:** pagamento da taxa por cartão, cancelamento com multa, intercâmbio e crédito de
  fracionamento, calendário visual no console, e o `PainelDoCliente/SimularUtilizacaoContrato` (a
  jornada usa a simulação do OPERADOR, a única que devolve `Bloqueado` por diária).

## 045 — Venda de ponta a ponta: do interesse ao contrato, com sinal por PIX
- **Entrega:** o ciclo comercial fecha sem humano no caminho feliz. O SDR (015a) qualificava,
  ofertava e **entregava o lead a um humano** — os dois encerramentos da máquina eram `agendado` e
  `aguardando_aprovacao`, e nada chegava ao ERP. Agora: aceite → nome e CPF → **PIX do sinal no
  WhatsApp** (template `cobranca_pix`, com link no corpo e copia-e-cola no `ORDER_DETAILS`) →
  pagamento confirmado → `SetPessoa` + `setcasal` + `SetVenda` → **contrato de multipropriedade
  criado**, com as parcelas em `contafinanceira` e a cota fora do estoque.
- **Onde está:** `packages/sdr` (etapas `dados` e `fechamento`, efeitos `emitir_sinal` e
  `registrar_venda`), `packages/erp-api-tse/src/venda.ts`, `apps/tse-sim/src/rotas/{recepcao,vendas}.ts`
  (+ `SetPessoa` em `cadastros.ts`), `apps/server/src/venda/` (`repo`, `worker`, `escalar`,
  `chave`, `vendas-routes`), o efeito no `sdr/fluxo.ts`, o gatilho em `pagamentos/eventos.ts`,
  migração `0020` e `apps/console/app/(console)/vendas/`.
- **A 045 abriu a raia do cotista.** `comprar_cota` com vínculo escalava para o comercial
  (`turno-handler.ts`); agora entra no SDR com nome e CPF do cadastro — e a etapa `dados` é
  **pulada**, então o CPF do cotista não volta a trafegar pela conversa. Era escopo da 031.
- **Três escritas encadeadas, nenhuma idempotente no TSE.** `SetPessoa` → `IdPessoa`,
  `setcasal` → **nada** (o POST responde string vazia!), `SetVenda` → `"IdContrato: 285"` em prosa.
  O id do casal sai de um **read-back por CPF** em `GetCasaisPorPeriodo`, e cada id é gravado em
  `venda` no instante em que nasce: uma tentativa que morre no meio retoma de onde parou em vez de
  criar uma segunda pessoa, um segundo casal ou (o pior) um segundo contrato.
- **Nada é escrito sem pagamento confirmado.** Quem enfileira `FILA_ERP_VENDA` é o evento do PSP,
  nunca o turno e nunca o LLM. A linha `erp_escrita` nasce na MESMA transação do `sinal_pago`, com
  `onConflictDoNothing` — reentrega de webhook não escreve duas vezes.
- **O CPF vem do parser, não do modelo.** `extrairCpf` roda sobre o texto cru, rejeita qualquer
  token de anonimização (`[CPF_1]`) e confere o DV. Na etapa `dados` o **LLM não é chamado**
  (`SEM_LLM` em `interpretar.ts`): mandar nome e CPF ao modelo seria mandar dado pessoal para fora
  sem necessidade, e aceitar a resposta dele deixaria um CPF nascer de saída estruturada.
- **O guard de `nao_entendi` vinha antes da etapa** — defeito achado pelo teste de precedência,
  não em revisão: em `transicionar`, o guard global roda antes do switch, então tudo que o
  comprador dissesse enquanto o PIX não caía contava como "não entendi", e duas mensagens
  derrubavam o fluxo **abandonando uma cobrança já emitida**. `fechamento` agora intercepta antes
  do guard; só `sinal_pago` (do webhook) e o pedido de humano avançam dali.
- **A 015a continua viva sozinha.** Sem `VENDA_SINAL_CENTAVOS` no contexto, o aceite volta a cair
  em `agendamento` — o degrau é explícito na máquina, não um efeito de configuração ausente.
- **Persona:** a `personaSdr` dizia "encaminha o fechamento para a equipe comercial" e "nunca peça
  CPF, nunca prometa código PIX". As duas frases foram reescritas junto com a persona do cotista e
  a regra 8 do prompt-base — sem isso o modelo contradiria o fluxo determinístico.
- **Como exercitar:** `apps/server/test/venda.integration.test.ts` (8 casos contra o simulador da
  035, incluindo o contrato conferido em `contrato`/`contafinanceira`, o reprocesso que não
  duplica e o token de anonimização recusado como CPF) e `apps/tse-sim/test/contrato.test.ts` (as
  5 rotas comerciais novas contra as fixtures do fornecedor).
- **Ficou de fora:** a **015b** (aprovar proposta abaixo do piso no console — quem pede abaixo da
  alçada continua parando sem resposta), assinatura de contrato, parcelamento negociado na
  conversa e prospecção ativa.

## 015b — SDR: aprovar, recusar ou contra-propor pelo console
- **Entrega:** o lead que pedia abaixo do piso ficava **sem resposta nenhuma**. A proposta entrava
  em `aguardando_aprovacao`, a tela de Leads mostrava os três botões com a nota "chegam com a
  015b", e o lead esperava alguém lembrar de falar com ele pela conversa. Agora um humano decide no
  console e a decisão **volta para o WhatsApp**.
- **Onde está:** `packages/sdr` (ações `aprovar_humano`/`recusar_humano`/`contrapropor_humano`,
  três textos novos), `apps/server/src/sdr/leads-routes.ts` (as duas rotas),
  `apps/server/src/sdr/fluxo.ts` (`aplicarDecisaoHumana`), migração `0021`, e os botões ligados em
  `apps/console/app/(console)/leads/page.tsx`.
- **Aprovar leva ao fechamento, não ao agendamento.** A pré-spec é de 08/09, antes da 045: aprovar
  agora leva ao mesmo destino do aceite (o PIX do sinal). Aprovar um valor e não deixar o lead pagar
  seria aprovação que não serve para nada. Com a 045 desligada, volta a cair em `agendamento`.
- **O valor decidido tem campo próprio.** `valorOfertadoCentavos` só sabia derivar `tabela` ou
  `piso` — um valor aprovado ABAIXO do piso não cabia em nenhum dos dois, e a derivação teria
  devolvido o piso, cobrando do lead um valor que ninguém aprovou.
  `fluxo_sdr.valor_acordado_centavos` guarda o que o humano decidiu e vence a derivação.
- **Recusar não encerra**: devolve o lead para `oferta` no piso, e a decisão passa a ser dele. O
  rascunho previa `encerrado:recusado`; os critérios de aceite já descreviam o contrário, e manter o
  lead vivo é melhor.
- **As três decisões partem de `encerrado`**, e por isso entram ANTES do guard de fluxo encerrado em
  `transicionar` — é de `encerrado:aguardando_aprovacao` que elas saem. A máquina recusa aplicá-las
  em qualquer outro estado: aprovar um fluxo que já seguiu adiante seria reabrir conversa alheia.
- **Trava de concorrência**: `UPDATE ... WHERE status = 'aguardando_aprovacao'` — dois atendentes
  clicando juntos, só um decide; o outro leva 409. E a contraproposta é validada contra a faixa
  ANTES de decidir, para que um 400 não consuma a pendência.
- **A contraproposta cria proposta NOVA** com `origem: 'humano'`, deixando a original `recusada`. As
  duas no histórico contam a negociação inteira, e o distiller consegue separar o que a máquina
  ofertou do que uma pessoa digitou.
- **Como exercitar:** `apps/server/test/sdr-aprovacao.integration.test.ts` (8 casos: os três
  caminhos, 409 na segunda decisão, 400 fora da faixa que não queima a pendência, 401 sem sessão e
  o sinal de aprendizado).
- **Ficou de fora:** papel `comercial` e permissão por papel (032) — qualquer sessão do console
  decide, como na aprovação de cobrança da 014.

## 040 — 2ª via de boleto em PDF pelo WhatsApp
- **Entrega:** o cotista pede "me manda a segunda via" e **o boleto chega em PDF**, com nome de
  arquivo legível (`boleto-parcela-03-20260310.pdf`). Até aqui o agente só sabia mandar texto: o
  `OutboundGateway` tinha `send` e `sendTemplate`, e a `outbox` só tinha `texto`.
- **Onde está:** `packages/wa-meta` (`sendDocument` + upload de mídia nos dois gateways),
  `packages/erp-api-tse` (`obterSegundaVia` + o GET binário em `http.ts`),
  `apps/tse-sim/src/boleto-pdf.ts` e a rota `SegundaViaBoleto`,
  `apps/server/src/wa/segunda-via.ts` (a tool), `wa/outbox.ts` (o worker resolve o anexo),
  `catalog/financeiro/boleto_da_parcela.yaml`, migração `0022` e o clipe de anexo no
  `inbox/painel-conversa.tsx`.
- **O PDF não é armazenado em lugar nenhum.** Escolhemos **upload de mídia** (`media_id`) em vez
  de link público assinado: o boleto traz nome, CPF e valor, e um link assinado é um endereço
  público para dado pessoal. Sem URL para servir, não há o que guardar — os bytes existem só entre
  a resposta do ERP e o `POST /media`, dentro do job. A pré-spec pedia `anexo_url`; a coluna virou
  um **descritor** (`{tipo, contaFinanceiraId, filename}`), resolvido no instante do envio.
- **Resolver no envio, e não ao enfileirar, é o que mantém o retry honesto.** Cada tentativa do
  pg-boss busca o arquivo de novo, em vez de reenviar um `media_id` que a Meta já pode ter
  expirado (eles valem 30 dias).
- **O modelo escolhe QUAL parcela; o servidor confere de quem ela é.** `titulo_id` é o único
  parâmetro que vem do LLM neste caminho, e `financeiro.boleto_da_parcela` tem o contrato como
  bind de **sessão** — pedir a parcela de outro contrato não devolve linha nenhuma e o fluxo nem
  começa. O PDF, esse, nunca chega perto do prompt.
- **Nenhuma falha vira silêncio.** ERP sem o arquivo ⇒ linha `falha` + ticket **+ uma mensagem
  honesta ao cotista**, dedupada pelo id da linha. Aqui o ticket sozinho não bastava, e é o que
  separa este caso do #29: o agente **acabou de prometer** o arquivo, e sumir depois de prometer é
  pior do que nunca ter oferecido. Terminal, sem retry — tentar de novo não faz o boleto aparecer.
  Descritor corrompido ⇒ **não** cai para texto puro, porque o cotista receberia a legenda sem o
  boleto. Janela de 24h fechada ⇒ nem faz upload, para não deixar arquivo esquecido na Meta.
- **Parcela sem boleto é explicada, não inventada.** A tool devolve o motivo com a forma de
  pagamento na mão — cartão recorrente e "boleto ainda não gerado" são respostas diferentes.
- **Bug achado por teste:** `vencimento` chega do `pg` como **Date**, não string ISO. Tratado
  como string, o nome do arquivo saía `boleto-parcela-100-17.pdf` — e a data da legenda sairia
  errada junto. `isoDia` (014) normaliza as duas formas sem deslocar o dia por fuso.
- **Efeito colateral corrigido de passagem:** o `seq` do turno era `fluxoIniciado ? 3 : 2`, um
  chute que colidiria com o dedupe (`turnoId:seq`) num turno com pagamento (2+ mensagens) e
  reserva juntos — a segunda mensagem sumiria em silêncio. Agora conta quantas saíram.
- **O boleto do dublê é sintético e diz isso no papel.** O PDF do fornecedor não está no repo
  (035): a fixture guarda só `contentType`, `bodyBytes` e o `sha256`. `apps/tse-sim` desenha o
  seu à mão (a stack é travada, não há lib de PDF) com tarja de **DOCUMENTO SIMULADO** —
  um boleto que parece pagável e não é seria pior que texto nenhum.
- **Como exercitar:** `apps/server/test/segunda-via.integration.test.ts` (7 casos ponta a ponta),
  `apps/tse-sim/test/boleto-pdf.test.ts` (a `xref` conferida por offset de byte),
  `apps/tse-sim/test/divergencias.integration.test.ts` (os 404 que o fornecedor não exemplificou)
  e `packages/wa-meta/test/documento.test.ts`.
- **Para ver na demo é preciso `TSE_BASE_URL`.** Sem ela o writer é o de memória, que não tem
  documento para servir — desenhar boleto é trabalho do ERP.
- **Ficou de fora:** o resto da 033 (inbound de mídia, áudio, OCR de comprovante), retenção por
  política (024) e o boleto do Asaas, que já vai por link em texto.
