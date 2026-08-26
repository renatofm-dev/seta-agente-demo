# 001 — Fundação do repositório

## Objetivo
Monorepo pnpm com esqueleto de todos os módulos, ambiente dev com um comando, CI mínima.

## Escopo
- Workspaces:
  ```
  apps/server/            # monolito Fastify (gateway WA, runtime, API console, workers pg-boss)
  apps/console/           # Next.js (App Router) + Tailwind 4 + shadcn/ui
  packages/domain-erp/    # tipos canônicos (só tipos, zero deps)
  packages/erp-connector/ # port DbConnector + impl pg
  packages/query-catalog/
  packages/agent/
  packages/ai-provider/
  packages/guardrails/
  packages/wa-meta/
  packages/crm/
  packages/rag/
  packages/skills/
  packages/observability/
  packages/client-config/ # schema Zod da config da implantação (1 cliente na POC)
  catalog/                # entradas YAML do catálogo
  skills-seed/            # skills escritos à mão para o seed
  kb/                     # markdown da base de conhecimento demo
  infra/                  # compose.dev.yml, compose.prod.yml, Caddyfile.snippet
  specs/                  # estas specs
  ```
- `compose.dev.yml`: 1 container Postgres 17 (imagem `pgvector/pgvector:pg17`) com DOIS bancos:
  `app` (produto) e `erp_mock` (ERP simulado). Init script cria bancos e usuários:
  `app_owner` (rw em app) e `erp_ro` (SELECT-only em erp_mock — criado na 002).
- Drizzle configurado no `apps/server` (migrations do banco `app`). Migrations do `erp_mock`
  são SQL puro em `infra/erp-mock/` (002) — o produto não é dono desse schema.
- `packages/client-config`: schema Zod de `configs/demo/client.yaml` (nome, persona, módulos
  habilitados, limites do agente). Carregado no boot do server.
- Env validada com Zod no boot (`apps/server/src/env.ts`); `.env.example` completo.
- Biome + dependency-cruiser (regra inicial: `packages/*` não importam de `apps/*`;
  `agent` não importa `erp-connector` — só via `query-catalog`).
- Vitest raiz; 1 teste real por package tocado nesta spec (nem que seja do schema Zod).
- CI (GitHub Actions): install → lint → typecheck → test → build, em PR e main.
- Scripts raiz: `dev` (compose up + server + console), `db:migrate`, `db:seed`, `test`, `lint`.

## Fora de escopo
GHCR/imagens (fica na 011), Better Auth (007), qualquer lógica de negócio.

## Critérios de aceite
- `pnpm i && pnpm dev` sobe Postgres, server (health em `/healthz`) e console (página vazia).
- `pnpm lint && pnpm test && pnpm build` verdes no CI.
- dependency-cruiser falha o build se uma regra de fronteira for violada (provar com teste).
