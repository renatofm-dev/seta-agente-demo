# seta-agente

Plataforma de atendimento autônomo da SETA para empresas de **multipropriedade** que usam o ERP
TS Explorer. O cotista fala pelo WhatsApp; o agente responde com dado real do contrato
(parcelas, saldo, cota, cancelamento, chamados), emite cobrança (boleto, PIX ou link de cartão)
quando ele quer pagar, passa a conversa para um atendente humano quando esbarra num limite e
aprende com a correção do humano — sempre com aprovação antes de mudar de comportamento. A
empresa dispara campanhas de template para a carteira, mede o resultado contra uma meta de
conversão e recebe leads sem cadastro num agente de vendas (SDR) com alçada de desconto. Tudo é
auditável por `traceId`.

Uma base de código, **uma instalação por cliente**: parte dos clientes não permite dado saindo
da rede deles, então tudo roda isolado, lendo o ERP por um espelho só-leitura e enviando à LLM
apenas texto anonimizado.

## Estado (setembro de 2026)

- Specs **000–017** entregues e no `main` (fundação, ERP mock, catálogo de queries, gateway
  WhatsApp, runtime do agente, guardrails, CRM + console HITL, RAG, skills com aprendizado,
  observabilidade, deploy, domínio de multipropriedade, disparos, cobrança, SDR, anonimização,
  relatório de campanhas). Detalhe por spec em [`docs/dev/04-modulos-entregues.md`](docs/dev/04-modulos-entregues.md).
- 373 testes automáticos; CI e release verdes.
- O que vem a seguir: [`docs/roadmap.md`](docs/roadmap.md) (marcos M0–M5 até o piloto, decisões
  D1–D9) e [`docs/dev/08-o-que-falta.md`](docs/dev/08-o-que-falta.md) (o mapa técnico, com uma
  pré-spec por item). Fotografia para os sócios em [`docs/status-do-projeto.md`](docs/status-do-projeto.md).

## Como funciona em um diagrama

```mermaid
flowchart LR
  C[Cotista / Lead<br/>WhatsApp] <--> META[Meta Cloud API]
  META -->|webhook assinado| S
  A[Atendente / Curador<br/>navegador] --> W[apps/console<br/>Next.js]
  W -->|/api/console/*| S
  subgraph instalacao["Uma instalação por cliente"]
    S[apps/server<br/>Fastify + pg-boss] --> AG[packages/agent<br/>LangGraph + guardrails]
    AG -->|tools| QC[packages/query-catalog<br/>YAML → SQL com binds]
    S <--> DB[(Postgres 17<br/>+ pgvector)]
  end
  QC -->|read-only| ERP[(Espelho do ERP<br/>views canônicas)]
  AG -->|texto anonimizado| LLM[LLM OpenAI-compatible]
  S <-->|cobrança / webhook| PSP[PSP Asaas]
```

Uma mensagem entra pelo webhook, vira um **turno** depois de um silêncio (debounce), atravessa o
grafo do agente (contexto → LLM ⇄ tools → guardrails de saída → fallback honesto), sai pelo
outbox e fica inteira no `trace_turno`. Quando o agente escala, o atendente assume no console;
quando o atendente corrige, o sistema propõe uma skill que só entra depois da curadoria. A
sequência completa está em [`docs/dev/02-arquitetura.md`](docs/dev/02-arquitetura.md).

## Começar em 5 minutos

Pré-requisitos: **Docker Desktop** rodando, **Node 24** e **pnpm 10** (`corepack enable` ativa a
versão pinada no `package.json`). Nenhuma chave é necessária para subir.

```sh
git clone git@github.com:renatofm-dev/seta-agente.git && cd seta-agente
pnpm install
cp .env.example .env     # sem editar já funciona
pnpm dev                 # Postgres (Docker) → tsc -b → migrações → server :3001 + console :3000
pnpm demo:seed           # noutro terminal: ERP mock + usuários + vínculos + skills + KB (idempotente)
```

Depois, em `http://localhost:3000`:

| Login | Senha | Vê |
|---|---|---|
| `atendente@demo.seta` | `atendente-demo-123` | Atendimento, Campanhas, Cobranças, Leads |
| `curador@demo.seta` | `curador-demo-123` | Aprendizado › Curadoria |

Converse com o agente sem WhatsApp em `http://localhost:3000/simulador` usando os números do seed:
`5511999990001` (contrato em dia), `5511999990002` (inadimplente), `5511999990003` (distrato em
análise). Um número fora do `contatos.yaml` cai na raia de lead frio (SDR). Espere o debounce
(`WA_DEBOUNCE_MS`, 10 s; frase terminada em `?` fecha antes).

O que muda conforme o `.env`:

- Sem `LLM_*` o agente responde o **fallback honesto** ("não consigo responder isso agora…") — o
  fluxo inteiro funciona, só não há modelo. Preencha `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
  para conversar de verdade.
- Sem `WA_ACCESS_TOKEN` o envio é **log-only**: nada sai para a Meta.
- Sem `ASAAS_API_KEY` o PSP é **simulado**: o drawer de Cobranças ganha "Simular pagamento".

## Testar com o WhatsApp de verdade

Precisa de um app Meta com o **número de teste** grátis (até 5 destinatários verificados) e das
variáveis `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_VERIFY_TOKEN` no `.env` — o passo a passo
está em [`docs/meta-setup.md`](docs/meta-setup.md). Depois:

```sh
brew install cloudflared
pnpm dev-whatsapp        # sobe o pnpm dev se preciso, abre um túnel e aponta o webhook SÓ do número de teste para a sua máquina
```

Mande "oi" do celular verificado e acompanhe em `http://localhost:3000/inbox`. `Ctrl+C` desfaz
tudo: o número volta ao webhook de produção do app. Por que funciona assim, o que o script faz em
cada passo e como fazer na mão: [`docs/dev/09-whatsapp-real-e-tunel.md`](docs/dev/09-whatsapp-real-e-tunel.md).

## Scripts

| Comando | Faz |
|---|---|
| `pnpm dev` | sobe Postgres, compila, migra e roda server (:3001) + console (:3000) + `tsc --watch` |
| `pnpm dev-whatsapp` | `pnpm dev` + túnel Cloudflare + override do webhook do número de teste (e webhook do Asaas, se configurado) |
| `pnpm demo:seed` | `db:seed` (ERP mock + app) + `kb:ingest` |
| `pnpm test` | `tsc -b` + Vitest (unitários e integração) |
| `pnpm lint` | Biome + dependency-cruiser (fronteiras entre pacotes) |
| `pnpm typecheck` | `tsc -b` + typecheck do console |
| `pnpm build` | `tsc -b` + `next build` |
| `pnpm db:migrate` | aplica `apps/server/drizzle/` |
| `pnpm kb:ingest` | reingere `kb/*.md` no VectorStore |
| `pnpm anonimizacao:modelo` | baixa o modelo NER (~135 MB) para `.modelos/` |

`pnpm dev` paraleliza os scripts `dev:*` da raiz com `pnpm run '/^dev:/'` (seletor por regex) —
`pnpm run --parallel` não serve porque força modo recursivo no workspace.

## Mapa do repositório

```
apps/server/        Fastify 5 + workers pg-boss: webhooks (WhatsApp, Asaas), /api/console/*, turno,
                    outbox, Drizzle (migrações em drizzle/), seed, ingestão da KB
apps/console/       Next.js (App Router) + React 19 + Tailwind: Atendimento, Campanhas, Cobranças,
                    Leads, Aprendizado, Métricas, Configurações, simulador
packages/           regras de negócio e ports — não importam de apps/*
  ports             ai-provider · erp-connector · rag (VectorStore) · skills (SkillRegistry) · payment-provider
  domínio           agent (grafo LangGraph) · guardrails · sdr · cobranca · crm · domain-erp
  transversais      query-catalog (YAML → SQL com binds nomeados) · anonimizacao (PII → token) ·
                    observability (pino + traceId) · wa-meta (Cloud API, HMAC) · client-config
catalog/            queries que o agente pode executar no ERP (uma YAML por query, com masking)
kb/                 base de conhecimento em Markdown (ingerida por pnpm kb:ingest)
skills-seed/        skills escritas à mão que entram no seed
configs/demo/       client.yaml (persona, módulos, metas) e contatos.yaml (wa_id → contrato) da demo
infra/              compose.dev.yml · compose.prod.yml · deploy.sh · docker/ · erp-mock/ · caddy/
specs/              000–017 entregues e pré-specs do que falta (fonte de verdade do comportamento)
docs/               documentação de desenvolvimento (dev/01–09), roadmap, status, guias, ADRs
tools/              dev-whatsapp.sh (túnel) · boundaries.spec.ts (prova das fronteiras)
```

Detalhe de cada pasta, com exports e quem usa o quê: [`docs/dev/03-mapa-do-repositorio.md`](docs/dev/03-mapa-do-repositorio.md).

## Testes

```sh
pnpm test                                                        # tudo (Postgres do compose.dev.yml precisa estar de pé)
DATABASE_URL=postgres://app_owner:app_owner_dev@localhost:5432/app_test pnpm test   # com o pnpm dev rodando: banco isolado
DATABASE_URL=…app_test npx vitest run apps/server/test/cobranca.integration.test.ts   # um arquivo
```

Unitários ficam em `packages/*/test`, `apps/console/test` e `apps/server/test/*.test.ts`; os de
integração (`*.integration.test.ts`) sobem o app inteiro com `FakeAIProvider`, gateway de log e
PSP simulado, e rodam em série porque compartilham o banco. Regras anti-flake e o molde de um
teste novo: [`docs/dev/06-como-desenvolver.md`](docs/dev/06-como-desenvolver.md#testes).

## Como contribuir

1. **Uma spec = uma sessão = um PR.** A spec (`specs/NNN-nome.md`) tem Objetivo, Escopo, Fora de
   escopo, Premissas e Critérios de aceite. O que está fora de escopo não entra de brinde.
2. Branch `spec/NNN-nome` (ou `fix/…`, `docs/…`) → implementar **com testes** → PR com as premissas
   assumidas na descrição e `Closes #N` da issue correspondente.
3. **Pronto** = critérios de aceite atendidos + `pnpm lint && pnpm test && pnpm build` verdes. O CI
   roda os três e só publica imagem com tudo verde.
4. Commits convencionais (`feat(server): …`, `fix(guardrails): …`, `docs: …`).
5. As issues abertas estão organizadas por label (`infra`, `spec`, `onboarding`, `dívida-técnica`,
   `good first issue`) e por milestone (M1, M2, M4 — as datas do roadmap). Quem está chegando começa
   pela issue de onboarding.

Convenções, receitas (nova query no catálogo, nova skill, nova migração, nova tela) e o fluxo de PR
empilhado: [`docs/dev/06-como-desenvolver.md`](docs/dev/06-como-desenvolver.md).

## Regras que não se negociam

Estão no [`CLAUDE.md`](CLAUDE.md) e valem para pessoas e agentes:

- **Stack travada** (SDK SETA v1.0): TypeScript estrito, Node 24, pnpm 10, Fastify 5, Zod, Drizzle,
  Postgres 17 + pgvector, pg-boss, Better Auth, pino, UUIDv7, LangGraph.js, Next.js + React 19,
  Tailwind 4, Vitest, Biome, dependency-cruiser. Dependência nova só com aprovação (e ADR quando for
  de infraestrutura).
- **SQL sempre com binds nomeados.** Interpolar ou concatenar valor em SQL é proibido em qualquer
  camada; parâmetros `source: session` nunca vêm da LLM.
- **Fronteiras vigiadas** pelo dependency-cruiser: `packages/*` não importam de `apps/*`; `agent`
  não importa `erp-connector` (dado só via `query-catalog`); ports expõem interface, nunca
  implementação.
- **Zod em toda fronteira de entrada**; IDs UUIDv7; logs pino estruturados com `traceId`.
- **`.env` nunca é commitado** e `.env.example` documenta toda variável que o server lê (há um
  teste que confere).

## Documentação

| Onde | O quê |
|---|---|
| [`docs/README.md`](docs/README.md) | índice de leitura: visão geral, arquitetura, mapa, módulos entregues, dados, como desenvolver, operação, o que falta, WhatsApp real |
| [`specs/README.md`](specs/README.md) | estado de cada spec, grafo de dependências e as pré-specs (015b, 015c, 018–034) |
| [`docs/roadmap.md`](docs/roadmap.md) · [`docs/status-do-projeto.md`](docs/status-do-projeto.md) | marcos, decisões e a fotografia do projeto |
| [`docs/adr/`](docs/adr/) | decisões de arquitetura (ex.: `0001-asaas-como-psp.md`) |
| [`docs/meta-setup.md`](docs/meta-setup.md) · [`docs/asaas-setup.md`](docs/asaas-setup.md) · [`docs/deploy-homelab.md`](docs/deploy-homelab.md) · [`docs/roteiro-demo.md`](docs/roteiro-demo.md) | guias operacionais: WhatsApp, PSP, deploy, demonstração |
