# 03 — Mapa do repositório

Números de 08/09/2026: 16 packages, 47 rotas, 6 filas, 36 tabelas, 17 migrações, 14 telas,
11 queries de catálogo, 18 specs, 373 testes. Para atualizar:

```sh
grep -rhoE "app\.(get|post|put|patch|delete)\('[^']+'" apps/server/src | sort -u | wc -l   # rotas
grep -c "pgTable(" apps/server/src/db/schema.ts                                             # tabelas
ls apps/server/drizzle/*.sql | wc -l                                                        # migrações
find catalog -name '*.yaml' | wc -l                                                         # queries
pnpm test 2>&1 | grep "Tests  "                                                             # testes
```

## Raiz

```
CLAUDE.md            regras do projeto (stack travada, escopo, fronteiras, segurança, git)
README.md            atalho para docs/README.md e os dois comandos de dev
package.json         scripts do monorepo (dev, test, lint, build, db:*, kb:ingest…)
pnpm-workspace.yaml  apps/* e packages/*; onlyBuiltDependencies (onnxruntime, sharp…)
tsconfig*.json       project references (tsc -b compila tudo)
biome.json           lint + format
vitest.config.ts     um runner para tudo; integração é serial (banco compartilhado)
.dependency-cruiser.cjs  fronteiras (ver 02)
.env.example         todas as variáveis, comentadas; .env nunca é commitado
```

## `packages/` — regras de negócio e ports

| Package | Responsabilidade | Exports que importam | Quem usa | Teste |
|---|---|---|---|---|
| `agent` | Grafo LangGraph do turno: contexto, agente ⇄ tools, guardrails de saída, fallback honesto. `prompt.ts` monta a persona; `tools-internas.ts` (escalar_para_humano, buscar_conhecimento, iniciar_pagamento…) | `createAgentRuntime`, `TEXTO_FALLBACK`, `TEXTO_TRANSICAO` | server (`turno-handler`) | `graph.test.ts` |
| `ai-provider` | Port `AIProvider` (chat com tools, embed) e implementação OpenAI-compatible; `testing.ts` tem o `FakeAIProvider` usado em toda a suíte | `createOpenAICompatibleProvider`, `createFakeProvider`, `ChatRequest` | server, guardrails, cobranca, sdr, skills, anonimizacao | `provider.test.ts` |
| `anonimizacao` | Detectores de PII (regex validado, dicionário de contexto, NER local), `Cofre` de tokens, decorator `createAnonymizingProvider` | `createAnonymizingProvider`, `Anonimizador`, detectores | server (`anonimizacao.ts`) | 5 arquivos (`ner.test.ts` pula sem modelo) |
| `client-config` | Schema Zod do `client.yaml` (nome, personas, módulos, limites, guardrails, campanhas) | `loadClientConfig`, `ClientConfig` | server | `client-config.test.ts` |
| `cobranca` | Máquina de estados do fluxo de pagamento (seleção → método → confirmação), parser determinístico, intérprete LLM de fallback, textos | `iniciar`, `transicionar`, `parsearResposta`, `interpretarResposta`, `TEXTO_*` | server (`pagamentos/`) | `cobranca.test.ts` |
| `crm` | Máquina de estados do ticket (função pura) | `transicionar`, `podeTransicionar`, `TICKET_STATUS` | server (`wa/tickets.ts`) | `crm.test.ts` |
| `domain-erp` | Tipos e constantes canônicos do domínio de multipropriedade (contrato, cota, título, inadimplência, cancelamento, chamado, tiers) — zero dependências | tipos | erp-mock, query-catalog, agent | `domain.test.ts` |
| `erp-connector` | Port `DbConnector` read-only com binds nomeados; validação de binds; implementação `pg` | `createPgConnector`, `NamedBindsSchema` | query-catalog, server | 3 arquivos (um de integração) |
| `guardrails` | Pipeline de hooks (`runBeforeReply`, `runToolHooks`), classificador de intenção, guardrail de preço | `guardrailPreco`, `INTENCOES`, `TRIGGER_POR_INTENCAO`, `Verdict` | agent, server | `guardrails.test.ts` |
| `observability` | pino com `traceId` UUIDv7; `ObsEmitter` (eventos de LLM, guardrail, escalonamento) | `createLogger`, `newTraceId`, `createNoopObsEmitter` | todos | `observability.test.ts` |
| `payment-provider` | Port `PaymentProvider`; Asaas (REST, sem SDK) e simulado; erros tipados | `createAsaasProvider`, `createSimulatedPaymentProvider`, `ambienteDaUrl` | server (`pagamentos/`) | `asaas.test.ts`, `simulado.test.ts` |
| `query-catalog` | Carrega e valida os YAML (`loader`), executa com timeout/limites/masking (`executor`), gera as tool specs para a LLM (`tools`), valida SQL (`validate-sql`) | `loadCatalog`, `createExecutor`, `buildToolSpecs`, `applyMasking` | server, agent | 6 arquivos + fixtures válidas/inválidas |
| `rag` | Port `VectorStore`, chunking de Markdown, fusão RRF (denso + lexical) | `NAMESPACES`, `VectorStore`, `chunk`, `rrf` | server (`rag/`) | `rag.test.ts` |
| `sdr` | Máquina de estados do SDR (qualificação → apresentação → oferta → agendamento), parser, intérprete LLM de fallback, textos em valor (nunca percentual) | `iniciar`, `transicionar`, `apresentar`, `parsearResposta` | server (`sdr/`) | `sdr.test.ts` |
| `skills` | Port `SkillRegistry`, formato Markdown de skill, prompt do distiller, retrieval por cosseno + overlap | `SkillRegistry`, `PROPOSTA_TIPOS`, `cosine` | server (`skills/`) | `skills.test.ts` |
| `wa-meta` | Gateway Meta Cloud API e gateway de log, assinatura HMAC do webhook, parse de payload, `TemplateApi` (criar/listar modelos) | `createMetaGateway`, `createLogGateway`, `verifySignature`, `createMetaTemplateApi`, `WaPhoneSchema` | server | `wa.test.ts`, `template.test.ts`, `payload-signature.test.ts` |

## `apps/server/src` — Fastify + workers

```
index.ts            boot: env → db → pg-boss → connector/executor (conciliado) → PSP →
                    LLM (+ decorator de anonimização) → gateway/TemplateApi → auth →
                    VectorStore → SkillRegistry → workers → buildApp → listen
app.ts              buildApp(): registra rotas conforme as deps presentes (testável sem WA/console)
env.ts              contrato de ambiente (Zod); em production recusa defaults de dev (P-28)
boss.ts             filas pg-boss e limites de retry
auth.ts / auth-routes.ts   Better Auth (e-mail + senha, papéis atendente/curador)
console-routes.ts   /api/console/*: instalação, resumo (badges), equipe, inbox, conversas,
                    conversa/:id (mensagens, financeiro, origem), ticket/* (assumir, devolver,
                    resolver, responder, traces), traces/:id/feedback, metricas, events (SSE)
disparos-routes.ts  013: modelos (criar, sincronizar), carteira, disparos
relatorios-routes.ts 017: relatório de campanhas
aprendizado-routes.ts 009: propostas, skills, gerar, aprovar/rejeitar, desativar, rollback
anonimizacao.ts     016: monta detectores e o acumulador por traceId
kb-ingest.ts        008: ingere kb/*.md no VectorStore (ns kb)
seed-app.ts         contatos.yaml → tabela contato; usuários demo do Better Auth
migrate.ts          aplica drizzle/ (usado pelo deploy)
query-event-sink.ts 010: grava evento_query por consulta ao ERP
obs-emitter.ts      010: grava evento_llm / evento_guardrail / evento_escalonamento
tz.ts               fuso do cliente (métricas, competência)
db/                 schema.ts (36 tabelas Drizzle) e index.ts (pool)
wa/                 routes (webhook), inbound (persistência), debounce, turno-handler,
                    outbox, disparo (013), tickets (HITL), vinculo, dev-routes (simulador)
pagamentos/         014: fluxo, candidatos, emitir, eventos, conciliacao, escalar, repo,
                    cobrancas-routes, webhook-routes, tool-cobranca-em-aberto
sdr/                015a: fluxo, estoque, escalar, repo, leads-routes
rag/                pgvector-store, tool-buscar-conhecimento
skills/             registry, distiller, sinais-job
```

Testes em `apps/server/test/`: um `*.integration.test.ts` por spec (sobem o app inteiro com
fakes contra o Postgres dev) e alguns unitários (`env`, `conciliacao`, `janela-adaptativa`).

## `apps/console` — Next.js

```
app/layout.tsx              fontes (DM Sans, Space Grotesk, JetBrains Mono) e globals.css
app/globals.css             tokens do design (cores, raios, papéis semânticos), print
app/login/page.tsx          login em duas metades
app/simulador/page.tsx      simulador de WhatsApp (dev) — POST /dev/inbound + SSE /dev/events
app/(console)/layout.tsx    casca: guarda de sessão, nav com badges, instalação, avisos, SSE
app/(console)/inbox/        Atendimento: lista-conversas, painel-conversa, painel-contexto
app/(console)/ticket/[id]   rota legada (redireciona para o inbox)
app/(console)/campanhas/    lista, nova (wizard 3 passos), [id] (funil + destinatários)
app/(console)/disparos/     rota legada da 013 (redireciona)
app/(console)/cobrancas/    lista + drawer (aprovar, recusar, simular pagamento)
app/(console)/leads/        lista + drawer (leitura; ações chegam com a 015b)
app/(console)/aprendizado/  explorador de turnos + feedback; curadoria (propostas, skills)
app/(console)/metricas/     visão geral; relatorio-campanhas (017)
app/(console)/config/       canal (modelos), regras, equipe, PSP, ERP, skills
components/ui/              button, card (Card/Kpi/Vazio/Barra), chip (Chip/Eyebrow/Ponto),
                            drawer, funil, input (Input/Select/Campo/Opcao), modal-motivo,
                            page-header (PageHeader/Pagina), tabela (Tabela/Linha/Filtros/Abas),
                            whatsapp (Avatar/PreviewWhatsApp)
lib/console-api.ts          tipos + cliente da API (um método por rota)
lib/formatos.ts             datas, moeda, telefone, janela de 24 h
lib/rotulos.ts              rótulos e papéis semânticos por status
lib/campanhas.ts            funil, resumo do mês, CSV
lib/relatorio.ts            agrupamentos, insights e CSV do relatório
next.config.ts              rewrites /api/* → SERVER_INTERNAL_URL (default :3001)
```

Testes em `apps/console/test/`: só os helpers puros (`formatos`, `relatorio`, `utils`).

## Conteúdo e configuração

```
catalog/            queries YAML por domínio — a única via de dado do ERP
  financeiro/       saldo_contrato, proxima_parcela, proximas_parcelas, titulos_atraso, total_pago
  contrato/         minha_cota, meu_produto, status_cancelamento
  atendimento/      meu_chamado
  comercial/        estoque_disponivel, condicoes_cota (price_source: true — raia SDR)
kb/                 base de conhecimento em Markdown (regulamento, taxas, distrato, pontos, canais)
skills-seed/        skills escritos à mão importados no seed (cobrança de parcela, distrato)
configs/demo/       client.yaml (nome, personas, módulos, limites, guardrails, campanhas)
                    contatos.yaml (wa_id → contrato, apelido, documento) — o CONTATOS_PATH
                    pode apontar para um arquivo pessoal fora do repo
```

## Infra e ferramentas

```
infra/compose.dev.yml    Postgres 17 + pgvector para dev e CI (bancos app, app_test, erp_mock)
infra/compose.prod.yml   db + server + console (imagens do GHCR); senhas via .env.prod
infra/deploy.sh          pull → migrações → up → healthcheck (TAG opcional)
infra/docker/            server.Dockerfile (embarca o modelo NER), console.Dockerfile (standalone),
                         demo-seed.sh
infra/erp-mock/          01-tabelas.sql (estrutura do TS Explorer), 02-views.sql (7 views
                         canônicas), 03-grants.sql (erp_ro só lê views), seed.ts
infra/postgres/          init de dev (usuários e bancos)
infra/caddy/             site block de seta.outerlab.com.br
tools/dev-whatsapp.sh    túnel Cloudflare + override do webhook no número de teste
tools/boundaries.spec.ts prova das regras do dependency-cruiser
.github/workflows/       ci.yml (lint, typecheck, Postgres, test, build) e release.yml
                         (imagens só com CI verde)
```

## Documentação

```
specs/        000–017 entregues; pré-specs do que falta; README com estado e grafo
docs/         este conjunto (dev/), roadmap, status, guias operacionais, ADRs
```
