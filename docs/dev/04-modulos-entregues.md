# 04 — Módulos entregues (specs 000–017)

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
| 014 | Compra e cobrança pelo WhatsApp | #59 | ✅ (PSP em modo de teste) |
| 015 / 015a | SDR para lead frio: dados + núcleo | #60, #64 | ✅ núcleo · 015b/015c faltam |
| 016 | Anonimização do que sai para a LLM | #61 | ✅ |
| M2 (P-28..P-33) | Blindagem para exposição | #64 | ✅ |
| Console redesenhado | Design "Console SETA" em todas as telas | #64 | ✅ |
| 017 | Relatório analítico de campanhas | #63 | ✅ |

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
