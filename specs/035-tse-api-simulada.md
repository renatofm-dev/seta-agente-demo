# 035 — Simulador da API do TSE (`apps/tse-sim`) e contrato a partir da coleção

> **Pré-spec** (rascunho de 14/09/2026): ainda não executada. Primeira fatia da frente
> **demo ponta a ponta**. Não depende de decisão externa — a coleção Postman do fornecedor é
> tudo que precisamos. Tamanho **G**. Trilha A.

## Objetivo
Hoje o "ERP simulado" é um banco Postgres lido por SQL (7 views sobre `erp_mock`). O TS Explorer
de verdade expõe uma **API HTTP** (ASP.NET, OAuth2 `password`, JSON em PascalCase) — documentada
na coleção do fornecedor, com 90 requests e 89 exemplos de resposta salvos. Esta spec constrói um
serviço que responde **como o TSE real**, sobre o mesmo `erp_mock`, com fidelidade provada contra
esses exemplos — e que **escreve**. É o ambiente que destrava tudo que o espelho read-only nunca
poderá fazer: baixa de pagamento, reserva, lead e venda.

Não temos ambiente de homologação do fornecedor. Sem este simulador, a integração por API só
seria testada no dia em que apontasse para a produção de um cliente.

## Reaproveita
- `infra/erp-mock/{01-tabelas,02-views,03-grants}.sql`: as tabelas físicas já têm os nomes do TS
  Explorer (`contrato`, `contafinanceira`, `cotauh`, `edificiohotel`, `pessoa`…). A API é mais um
  cliente dessa base — exatamente como no espelho real.
- `infra/erp-mock/seed.ts`: `applySchema` (`:199-206`) varre **todo `*.sql` do diretório em
  ordem** — os arquivos novos entram de graça em `pnpm db:seed:erp` e em todo teste de
  integração. `seedData`, `cpfValido()` (`:31`) e os contratos de demo 10001/10002/10003.
- `apps/server`: a separação `app.ts` (`buildApp(deps)`) / `index.ts` (`listen`) é o que torna os
  testes injetáveis por `app.inject()`; `src/env.ts` é o molde de env validado por Zod.
- `vitest.config.ts` e o padrão de teste de integração que importa `applySchema`/`seedData`
  (`packages/query-catalog/test/executor.integration.test.ts:18`).
- `pnpm anonimizacao:modelo` como molde de ferramenta de dev one-shot fora do CI.

## Escopo

### `apps/tse-sim` (workspace novo)
Serviço Fastify. Vai em `apps/`, não em `infra/`: é executável, precisa de `package.json` próprio
(Fastify, Zod, `pg` — **nenhuma dependência nova no repo**) e de entrada no `tsc -b`; `infra/`
guarda SQL, compose e Dockerfiles, e a única exceção (`infra/erp-mock/seed.ts`) é script, não
serviço.

```
apps/tse-sim/
  src/
    index.ts            loadEnv() + listen
    env.ts              TSE_SIM_PORT, TSE_SIM_DATABASE_URL, TSE_SIM_USERS,
                        TSE_SIM_PAINEL_ESCOPO, TSE_SIM_LATENCIA_MS, TSE_SIM_FALHA_BPS
    app.ts              buildTseSimApp(deps) → FastifyInstance
    auth.ts             /token (GET e POST), tokens em memória, expires_in 86399
    plugin-bearer.ts    preHandler: valida Authorization, 401 no formato do TSE
    pascal.ts           numeric→decimal, date→"YYYY-MM-DDT00:00:00-03:00"
    rotas/              painel-do-cliente · utilizacao-contrato · financeiro ·
                        cadastros · recepcao · vendas · lookup
  contrato/
    tse-api.collection.json    coleção SANITIZADA
    tse-api.collection.sha256  hash do original, prova de procedência
    fixtures/<slug>.json       89 exemplos extraídos
    indice.json                método, path, params, arquivo, contentType
  test/
    contrato.test.ts           cada rota bate com a fixture (forma, não valor)
    escrita.integration.test.ts  TransacaoEletronica muda `contafinanceira` de verdade
```

**Rotas desta fatia** (as demais chegam com 038/039/040, e a lista `PENDENTES` do teste de
contrato vigia isso):
`POST|GET /token` · `PainelDoCliente/{MeusContratos, MeusDadosCadastrais, FinanceiroContrato,
MeusBoletos, ObterTaxasDPNU}` · `utilizacaocontrato/obtercontratos` ·
`cadastros/{GetPessoa, GetPessoaCpf}` · `Lookup/*` (servidas direto das fixtures) ·
`financeiro/TransacaoEletronica` · `financeiro/ContaFinanceira` (POST/PUT).

### Banco: reaproveita o `erp_mock`, com papel próprio
O simulador **escreve** nas tabelas físicas; `erp_ro` só enxerga as views e `ERP_MOCK_ADMIN_URL` é
superusuário (um bug do sim apagaria a demo). Terceiro papel, terceira fronteira:

| Papel | Enxerga | Quem usa |
|---|---|---|
| `postgres` | tudo | `pnpm db:seed:erp` |
| `erp_ro` | só as 7 views canônicas | produto (`ERP_DATABASE_URL`) |
| `tse_sim` **(novo)** | SELECT/INSERT/UPDATE nas tabelas físicas + schema `tse_sim`; **zero** nas views | simulador (`TSE_SIM_DATABASE_URL`) |

Três arquivos novos em `infra/erp-mock/` — **nunca** em `infra/postgres/init/01-init.sh`, que só
roda no primeiro boot do volume e obrigaria todo dev a `docker compose down -v`:

- `04-sim-role.sql` — `DO` block idempotente criando `tse_sim`, `GRANT CONNECT`,
  `GRANT SELECT,INSERT,UPDATE` nas tabelas físicas, `REVOKE ALL ON v_*`.
- `05-sim-schema.sql` — schema `tse_sim` com o que a API tem e o mock ainda não:
  `utilizacaocontrato`, `hospede`, `tipopensao`, `casal`, `transacaoeletronica`, `operador`.
  **Fora do `public`**, para não poluir a superfície que a 018 vai replicar no espelho real.
- `06-sim-sequences.sql` — as PKs de `01-tabelas.sql` são `integer PRIMARY KEY` **sem identity**;
  nenhum INSERT da API funciona sem `ADD GENERATED BY DEFAULT AS IDENTITY` + `setval`. E
  `seedData` (que trunca e reinsere com ids explícitos) precisa **ressincronizar os `setval` no
  fim** — senão o segundo `pnpm db:seed` quebra com violação de PK.

### Fixtures e teste de contrato
`tools/tse-fixtures.ts`, exposto como `pnpm tse:fixtures`:
1. lê a coleção de `TSE_COLLECTION_PATH`;
2. confere o `sha256` contra `contrato/tse-api.collection.sha256`;
3. **sanitiza** — `access_token` e `Authorization` → `SCRUBBED`; e-mails do fornecedor →
   `integracao@exemplo.com.br`; CPFs → fictícios com DV válido (`cpfValido()` já existe); nomes de
   pessoa → `INTEGRACAO TSE`;
4. **remove comentários JSON** — os bodies de `CriarUtilizacaoContrato` e `AdicionarHospede` têm
   `//IdTipoOrigemContaFinanceira`; `JSON.parse` quebra sem esse passe;
5. escreve `fixtures/<pasta>__<slug>.json` (`{nome, method, path, pathParams, query, requestBody,
   status, contentType, body}`) e `indice.json`; o PDF de `SegundaViaBoleto` vira
   `segunda-via-boleto.pdf.b64`.

**A coleção sanitizada vai para o repo.** Sem ela ninguém regenera nem audita as fixtures, e não
temos ambiente do TSE — ela *é* o contrato. O original fica fora do git; o `sha256` prova
procedência.

`test/contrato.test.ts`: para cada fixture, `app.inject()` e compara **a forma** — conjunto de
chaves em PascalCase, tipo de cada valor, formato de data com `-03:00`. Mais duas asserções que
valem o teste inteiro: nenhuma chave da resposta do sim fora do conjunto da fixture (não inventar
campo), e a lista `PENDENTES` de rotas não implementadas só encolhe.

### Divergências da coleção que o simulador documenta
- **`/token` e `utilizacaocontrato/SimularUtilizacaoContrato` estão como `GET` com body.** `fetch`
  do Node lança `Request with GET/HEAD method cannot have body`. O endpoint OWIN `/token` aceita
  POST (é o padrão do ASP.NET). O simulador registra **as duas rotas**, com teste que documenta a
  divergência; o adapter (036) usa POST.
- **`TSE_SIM_PAINEL_ESCOPO=token|qualquer`.** No exemplo salvo o token é de `TSE.INTEGRACAO` e
  `MeusContratos` devolve o contrato *desse usuário* — o painel pode resolver escopo pelo dono do
  token, e o agente atende N cotistas com **uma** credencial. Enquanto o fornecedor não responde,
  o simulador exercita os dois comportamentos.

### Integração com o repo
- `package.json`: `dev:tse-sim` ao lado de `dev:server`/`dev:console` (o `pnpm dev` roda
  `/^dev:/`), e `tse:fixtures`. **O sim não entra no `infra/compose.dev.yml`** — esse compose tem
  um serviço só (`postgres`); `server` e `console` também rodam no host.
- `.env.example` + `apps/server/test/env.test.ts` continuam batendo (bloco `TSE_SIM_*`).
- `docs/dev/05-dados-e-integracoes.md`: a seção do ERP ganha o terceiro papel e a API.

## Fora de escopo
- O adapter HTTP, o catálogo por HTTP e qualquer mudança em `apps/server` (036/037).
- Endpoints de `OperadorSistema` e `Reports` — 30 rotas que nenhuma jornada da demo usa.
- Reserva (038), lead/venda (039), 2ª via em PDF (040).
- `infra/docker/tse-sim.Dockerfile`, `compose.prod.yml` e release do sim — fatia própria, só se a
  demo for para a VPS.

## Premissas
- A coleção é o contrato: sem ambiente do fornecedor, **forma vale mais que valor**. O teste de
  contrato compara estrutura, não conteúdo.
- O simulador **nunca calcula regra de negócio nossa**. Ele é fiel ao TSE, ponto — senão o adapter
  passa nos testes contra o sim e falha contra o TSE real.
- Um teste de escrita que baixa uma parcela do 10002 e não reverte **quebra**
  `apps/server/test/cobranca.integration.test.ts` e
  `packages/query-catalog/test/executor.integration.test.ts` (`vitest.config.ts` tem
  `fileParallelism: false` e as suítes compartilham o Postgres). Escrita roda contra banco
  dedicado ou reexecuta `seedData` no `afterEach`.

## Critérios de aceite
- `pnpm dev` sobe o simulador em `:3010`; `curl -d 'grant_type=password&username=…&password=…'
  localhost:3010/token` devolve o envelope do exemplo (`access_token`, `token_type: bearer`,
  `expires_in: 86399`).
- `GET /api/PainelDoCliente/FinanceiroContrato?idContrato=10002&paginaAtual=1` devolve as parcelas
  do seed em PascalCase, com datas `-03:00` e os agregados do topo (`QtdParcelasEmAtraso`,
  `TotalPaginas`).
- `POST /api/financeiro/TransacaoEletronica` grava `contafinanceira.datarecebimento` e
  `SELECT status FROM v_titulo WHERE id = …` passa a `pago` — **a mesma base, a mesma verdade**.
- Rota sem `Authorization` válido responde 401 no formato do TSE.
- `pnpm tse:fixtures` é idempotente; `grep -rE 'timesharesolucoes|[0-9]{11}' apps/tse-sim/contrato`
  não acha e-mail nem CPF do fornecedor.
- Teste de contrato verde, com `PENDENTES` explícito; teste de escrita verde rodando **duas vezes
  seguidas** (prova a ressincronização dos `setval`).
- `pnpm lint && pnpm test && pnpm build` verdes.

## O que dá para demonstrar ao final
"Este é o TS Explorer. Peço o token, leio o financeiro do contrato 10002 — mesmo formato do
fornecedor — posto uma transação eletrônica, e a parcela fica paga no banco do ERP."

## Decisões a resolver (registrar a escolha na descrição do PR)
- Porta do simulador (`3010` é sugestão) e se `pnpm dev` sobe o sim por default ou sob flag.
- Nome do papel: `tse_sim` ou `erp_rw`.
- Se o `TSE_SIM_LATENCIA_MS`/`TSE_SIM_FALHA_BPS` (caos controlado) entram já ou ficam para a 041.
