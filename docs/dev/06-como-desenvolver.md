# 06 — Como desenvolver

## Pré-requisitos

- Docker Desktop rodando (`docker info`)
- Node 24 (`node -v`) e pnpm 10 (`corepack enable` ativa a versão pinada no `package.json`)
- Chave de um provedor LLM OpenAI-compatible (opcional para subir; necessária para o agente
  conversar de verdade)

## Subir o ambiente

```sh
pnpm install
cp .env.example .env        # sem editar já funciona: agente responde o fallback honesto
pnpm dev                    # Postgres (Docker) → tsc -b → migrações → server :3001 + console :3000 + tsc watch
pnpm demo:seed              # ERP mock + usuários + vínculos + skills seed + KB (idempotente)
```

Para o agente responder com modelo, preencha no `.env`: `LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_MODEL` (e `EMBEDDING_MODEL` + `EMBEDDING_DIM` se o provedor tiver embeddings; sem isso
a KB fica só lexical, e funciona).

Logins do console (`http://localhost:3000`): `atendente@demo.seta` / `atendente-demo-123`
(Atendimento, Campanhas, Cobranças, Leads) e `curador@demo.seta` / `curador-demo-123`
(Aprendizado › Curadoria). Use dois navegadores para os dois papéis.

**Simulador** (`http://localhost:3000/simulador`, exige login): números do seed
`5511999990001` (contrato 10001, em dia), `…0002` (inadimplente), `…0003` (distrato em
análise). Um número fora do `contatos.yaml` é lead frio (raia SDR). Espere o debounce
(`WA_DEBOUNCE_MS`, 10 s; frase terminada em `?` fecha antes).

**WhatsApp real** (número de teste da Meta): `pnpm dev-whatsapp` faz o mesmo que `pnpm dev`
e abre um túnel Cloudflare apontando o webhook **só do número de teste** para a sua máquina;
`Ctrl+C` desfaz. Requer `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_VERIFY_TOKEN` (ver
[`meta-setup.md`](../meta-setup.md)). Para campanhas, `WA_WABA_ID`. Como o túnel e o override
funcionam, passo a passo e diagnóstico: [`09-whatsapp-real-e-tunel.md`](09-whatsapp-real-e-tunel.md).

**Pagamentos:** sem `ASAAS_API_KEY` o PSP é simulado e o drawer de Cobranças tem "Simular
pagamento". Com o sandbox, ver [`asaas-setup.md`](../asaas-setup.md); o `dev-whatsapp`
registra o webhook do Asaas pelo túnel.

Se a porta 3000 estiver presa por outro processo, o Next cai para 3001 e derruba o server:
descubra o dono com `lsof -nP -iTCP:3000 -sTCP:LISTEN` antes de subir.

## Scripts

| Comando | Faz |
|---|---|
| `pnpm dev` / `pnpm dev-whatsapp` | ambiente completo (ver acima) |
| `pnpm test` | `tsc -b` + Vitest (unitários e integração) |
| `pnpm lint` | Biome (`check .`) + dependency-cruiser |
| `pnpm typecheck` | `tsc -b` + typecheck do console |
| `pnpm build` | `tsc -b` + `next build` |
| `pnpm db:migrate` | aplica `apps/server/drizzle/` |
| `pnpm db:seed` / `pnpm demo:seed` | ERP mock + app; `demo:seed` também ingere a KB |
| `pnpm kb:ingest` | reingere `kb/*.md` no VectorStore (remove documento cujo arquivo sumiu) |
| `pnpm anonimizacao:modelo` | baixa o modelo NER para `.modelos/` (testes de NER e produção) |

## Testes

- **Unitários** (`packages/*/test`, `apps/console/test`, `apps/server/test/*.test.ts`):
  funções puras, sem banco.
- **Integração** (`apps/server/test/*.integration.test.ts`): sobem o app inteiro com
  `FakeAIProvider`, gateway de log, `TemplateApi` fake e PSP simulado contra o Postgres do
  `compose.dev.yml`. São **seriais** (`fileParallelism: false`) porque compartilham o banco e
  o `beforeEach` trunca tabelas.
- **Com o `pnpm dev` de pé**, use o banco isolado para não colidir com a fila pg-boss do dev:
  ```sh
  DATABASE_URL=postgres://app_owner:app_owner_dev@localhost:5432/app_test pnpm test
  DATABASE_URL=…app_test npx vitest run apps/server/test/cobranca.integration.test.ts   # um arquivo
  ```
- Regras que evitam flake: aguardar sempre o artefato que o assert lê (`trace_turno` é
  gravado por último no turno); não rodar `next build` em paralelo com a suíte (timeout de
  conexão); o `beforeEach` de um teste novo precisa limpar também as tabelas de outras
  suítes que referenciam `conversa` (`lead`, `fluxo_sdr`, `proposta_sdr`, cobrança…).
- Os testes de NER (`packages/anonimizacao/test/ner.test.ts`) são `skipIf` sem o modelo em
  cache; o CI não baixa 135 MB.
- Escreva o teste de integração no molde do mais parecido: `disparos` (modelos + webhook de
  status), `cobranca` (fluxo pelo simulador + pagamento simulado), `relatorio-campanhas`
  (os dois juntos).

## Convenções

- **Zod em toda fronteira de entrada** (rotas, env, YAML, webhooks); erro de validação vira
  400 com `z.prettifyError`.
- **IDs UUIDv7** (`newTraceId()` de `@seta/observability`); **logs pino** estruturados com
  `traceId`; nunca `console.log`.
- **SQL só com binds nomeados**; interpolar valor é proibido em qualquer camada (o loader do
  catálogo e o `NamedBindsSchema` rejeitam). Params `source: session` nunca vêm do modelo.
- **Ports expõem interface, nunca implementação**; o dependency-cruiser falha o lint se
  uma fronteira for cruzada (ver [02](02-arquitetura.md)).
- **Nada de dependência nova** fora da stack travada sem decisão registrada no `CLAUDE.md`.
- **Texto do produto** (mensagens do WhatsApp, console): português, curto, sem travessão;
  valores sempre vindos de tool; o SDR fala em valor, nunca em percentual.
- **Commits convencionais** (`feat(escopo): …`, `fix(...)`, `docs(...)`, `test(...)`); o
  corpo explica a premissa, não repete o diff.
- **Design do console**: tokens em `app/globals.css` (nunca hex solto em componente), raiz
  tipográfica em 16px (o corpo de 14px fica no `body`), componentes de `components/ui`;
  o que não tem backend aparece como nota ("chega com a spec X"), nunca como botão morto.
- **Fuso**: buckets de métricas e competência usam `TZ_CLIENTE` (`apps/server/src/tz.ts`).

## Fluxo de trabalho

1. **Uma spec = uma sessão = um PR.** A spec (`specs/NNN-nome.md`) tem Objetivo, Escopo por
   área, Fora de escopo, Premissas e Critérios de aceite. O que está em "fora de escopo" não
   entra de brinde; se algo de outra spec bloquear, stub mínimo tipado e nota no PR.
2. Branch `spec/NNN-nome` (ou `fix/…`, `docs/…`) → implementar **com testes** → mostrar o
   resumo do diff → commit → PR com premissas assumidas na descrição e `Closes #N`.
   **Push só com confirmação** do CTO.
3. "Pronto" = critérios de aceite atendidos + `pnpm lint && pnpm test && pnpm build` verdes.
4. Ambiguidade: no máximo 3 perguntas antes de começar; fora isso, premissa explícita
   registrada no PR.

**PR empilhado** (um PR cuja base é a branch de outro):
- "MERGED" no GitHub não prova que o conteúdo chegou no `main`. Conferir por
  ancestralidade (`git merge-base --is-ancestor <head> origin/main`) e por conteúdo
  (`git cat-file -e origin/main:<arquivo marcante>`).
- Mergear na ordem pai → filho. **Apagar a branch base de um PR aberto fecha o PR filho**:
  reapontar o filho (`gh pr edit N --base main`) antes de apagar a base.

## Receitas

**Uma query nova no catálogo.** Criar `catalog/<dominio>/<nome>.yaml` no formato de
`financeiro/titulos_atraso.yaml` (binds nomeados, só views, `output.columns`, `tool.name`);
`pnpm dev` recarrega e o loader valida no boot; teste em `packages/query-catalog/test`
(fixture válida) e, se a tool muda o comportamento do agente, um cenário em
`agente.integration.test.ts`.

**Uma migração.** Editar `apps/server/src/db/schema.ts`; `pnpm --filter @seta/server exec
drizzle-kit generate --name <slug>`; conferir o SQL gerado; o snapshot entra no PR.

**Uma rota de console.** Plugin no molde de `relatorios-routes.ts` (preHandler de sessão,
`setErrorHandler` para Zod), registrado em `app.ts` dentro do bloco `consoleDeps`; tipo e
método em `apps/console/lib/console-api.ts`; teste de integração com `app.inject` e cookie
de login (`USUARIOS_DEMO`).

**Uma tela no console.** Página em `app/(console)/<rota>/page.tsx` com `Pagina` +
`PageHeader`; dados por `api.*`; `Card`/`Kpi`/`Tabela`/`Chip`/`Drawer` de `components/ui`;
filtros na URL quando o link precisa ser compartilhável (molde: `metricas/relatorio-campanhas.tsx`);
`useSearchParams` sempre dentro de `Suspense`. Helpers puros em `lib/` com teste em
`apps/console/test`.

**Um worker pg-boss.** Fila em `boss.ts` (retry explícito), `registerXWorker({ db, boss, … })`
em `index.ts`, job enviado **depois** do commit da transação que cria o dado (padrão do
outbox), idempotência por chave.

**Um guardrail.** Hook `beforeTool`/`afterTool`/`beforeReply` em `packages/guardrails`
devolvendo `Verdict`; registrar no `turno-handler` (por raia, se for o caso); todo verdict
diferente de `allow` já vai para o trace e vira sinal.

**Um detector de PII.** `Detector` em `packages/anonimizacao/src/detectores/` com validação
que evite falso positivo em número de contrato e valor; teste em `detectores.test.ts`.

**Screenshots do console sem mexer no dev do CTO.** Server extra em outra porta apontando
para `app_test` (`PORT=3002 DATABASE_URL=…app_test node --env-file=.env apps/server/dist/index.js`),
`next build` com `SERVER_INTERNAL_URL=http://localhost:3002` e `next start -p 3005`; login
direto no server com `origin` igual ao `BETTER_AUTH_URL`; capturar por CDP com Chrome
headless. Um `next dev` extra na mesma pasta é recusado pelo lock do Next.

## Onde ficam as regras e a memória

- `CLAUDE.md`: regras do projeto e decisões registradas (o agente de código lê antes de tudo).
- `specs/README.md`: estado das specs, grafo de dependências e regra de numeração.
- `docs/roadmap.md`: calendário, marcos, decisões pendentes.
