# 07 — Operação e deploy

## Esteira (`.github/workflows/ci.yml`)

Roda em todo push no `main` e em todo PR:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint` — Biome + dependency-cruiser (fronteiras)
3. `pnpm typecheck` — `tsc -b` + typecheck do console
4. `docker compose -f infra/compose.dev.yml up -d --wait` — Postgres com pgvector
5. `pnpm test` — unitários e integração (serial, banco compartilhado)
6. `pnpm build` — `tsc -b` + `next build`

Nada entra no `main` sem os seis passos verdes. Não há proteção de branch no GitHub (plano
free em repo privado), então a disciplina é do fluxo de PR.

## Release (`.github/workflows/release.yml`)

- Dispara **depois** do workflow `ci` terminar com sucesso no `main` (`workflow_run`), no SHA
  que o CI validou — push com teste quebrado não gera imagem (P-30). `workflow_dispatch`
  republica um SHA à mão.
- Duas imagens no GHCR: `ghcr.io/<owner>/seta-agente-server` e `…-console`, com as tags
  `latest` e `<sha>`. Numeração de versão (`vX.Y.Z`) chega com a spec 021.
- `infra/docker/server.Dockerfile`: build com `tsc -b`, runtime só com deps de produção,
  **baixa o modelo NER na build** (o container sobe sem rede para o Hugging Face).
- `infra/docker/console.Dockerfile`: `next build` standalone; `SERVER_INTERNAL_URL` é lido
  no build (os rewrites são fixados na imagem).

## Homelab (`seta.outerlab.com.br`)

Preparação única em [`deploy-homelab.md`](../deploy-homelab.md): swap, clone raso (só
`infra/` e `docs/`), login no GHCR com PAT `read:packages`, Caddy do host com o site block
de `infra/caddy/`, `.env.prod` com as senhas (nunca no compose — P-29).

Deploy:

```sh
./infra/deploy.sh            # latest
./infra/deploy.sh <sha>      # uma imagem específica
```

O script faz `pull` → sobe `db` → `migrate.js` → sobe `server` e `console` → `curl /healthz`.
Seed de demo idempotente: `docker compose … exec server sh /app/demo-seed.sh`.

`infra/compose.prod.yml`: `db` (pgvector/pg17, sem porta publicada), `server` (:3001),
`console` (:3000). O Caddy do host faz o TLS e o roteamento.

**Estado em 08/09/2026:** o homelab roda a versão de agosto. Publicar a atual é o item
P-21 do roadmap: rodar o `deploy.sh`, rotacionar as senhas de `app_owner`/`erp_ro` (resto do
P-29) e rodar o seed.

## Ambiente de produção

- `NODE_ENV=production` faz o boot **recusar** `WA_VERIFY_TOKEN`, `WA_APP_SECRET`,
  `BETTER_AUTH_SECRET` com os valores de dev e senhas de dev na `DATABASE_URL` (P-28,
  `env.ts`). Um servidor exposto nunca sobe com segredo de exemplo.
- Sem `WA_ACCESS_TOKEN` o gateway é de log; sem `ASAAS_API_KEY` o PSP é simulado; sem
  `LLM_BASE_URL` o agente responde o fallback honesto. O boot loga qual está ativo — o
  console mostra avisos amarelos para gateway em modo teste e PSP simulado.
- `ASAAS_BASE_URL` decide sandbox ou produção; o boot loga o ambiente para ninguém
  confundir cobrança de teste com cobrança real.

## Observabilidade

| Onde | O que |
|---|---|
| Logs pino (stdout, JSON) | todo log de turno e request tem `traceId`; `LOG_LEVEL` controla |
| `trace_turno` | por turno: contexto, tools expostas e chamadas, verdicts, resposta, tokens, latência, evento de anonimização (contagens) |
| `evento_llm`, `evento_guardrail`, `evento_escalonamento`, `evento_query` | derivados do turno; alimentam `/api/console/metricas` |
| Console › Métricas | conversas por dia, resolvido sem humano, motivos de escalada, p95, custo estimado; relatório de campanhas |
| Console › Aprendizado › Turnos | explorador de traces com feedback 👍/👎 |
| `/healthz` | `{ status, cliente, uptimeSegundos }`; sem versão ainda (021) |

Não existe alerta automático nem monitor externo (I-04, spec 026).

## Backup

Manual hoje (`docs/deploy-homelab.md`). Backup automático com **restore testado** é o
P-34 (spec 026). Até lá, antes de qualquer migração no homelab: `pg_dumpall` à mão.

## Runbook mínimo (o que fazer quando…)

| Sintoma | Onde olhar | Causa provável |
|---|---|---|
| Webhook da Meta responde 401 | logs `wa/routes.ts` | `WA_APP_SECRET` diferente do app da Meta |
| Mensagem não sai; ticket marcado "entrega falhou" | `outbox` com `status = falha`, dead-letter do pg-boss | token expirado, número fora do WhatsApp; corrigir e reenfileirar |
| Agente responde só o fallback | boot: `llm: ausente` ou erro 4xx do provedor | `LLM_*` ausentes ou chave inválida |
| Console mostra "…" no nome da instalação | server antigo sem `/api/console/instalacao` | reiniciar o server com a versão atual |
| Modelos de mensagem indisponíveis | aviso amarelo em Configurações › Canal | `WA_WABA_ID`/`WA_ACCESS_TOKEN` ausentes |
| Teste de integração com timeout de conexão | rodou junto com build/next dev | rodar o arquivo isolado com `DATABASE_URL=…app_test` |

## O que falta para operar de verdade

Rate limit nos webhooks, inspeção e reprocesso de dead-letter, segredos em cofre, retenção
de logs, monitor com alerta, backup automático, versão identificada por instalação — tudo
mapeado em [08 — O que falta](08-o-que-falta.md) (specs 021, 022, 026).
