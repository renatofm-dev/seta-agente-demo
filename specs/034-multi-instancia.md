# 034 — Multi-instância do server: N réplicas, debounce fora do processo

> **Pré-spec / rascunho M5** (08/09/2026): dívida #33 (`debounce.ts:77`). Depende da 021 e
> só faz sentido quando uma instalação precisar de mais de um processo (volume ou
> disponibilidade).

## Objetivo
O server é um processo único: a serialização por conversa do debounce vive num `Map` em
memória e o worker do turno assume que ninguém mais processa a mesma conversa. Com duas
réplicas, dois turnos da mesma conversa podem correr em paralelo e responder duas vezes.
Esta spec tira o estado do processo e prova N réplicas atrás do mesmo banco e das mesmas
filas.

## Reaproveita
- pg-boss já é compartilhado (schema `pgboss` no banco): filas funcionam com N workers;
  `singletonKey`/`singletonSeconds` do pg-boss para dedupe de job por conversa.
- `turno-handler.ts › enfileirarComFusao` já usa lock da conversa e do ticket na transação
  (#46/#47) — o padrão certo, só o debounce ficou fora.
- `outbox` com dedupe por chave; `varrerPendentesOrfas`.
- `/healthz` com filas (026), release por cliente (021), staging.

## Escopo
- Debounce: `Map` ⇒ `pg_advisory_xact_lock(conversa)` no `processarDisparo` + job com
  `singletonKey = conversaId` e janela; re-agendamento idempotente.
- Turno: lock da conversa durante o turno inteiro (advisory lock de sessão com timeout) para
  que a segunda réplica pule e re-agende em vez de duplicar.
- SSE do console (`/api/console/events`): hub por processo ⇒ `LISTEN/NOTIFY` do Postgres
  para que qualquer réplica publique e todas escutem.
- Cache do dicionário de nomes da anonimização e do `ClientConfig` (032): invalidação por
  `NOTIFY`.
- `compose.prod.yml` com `deploy.replicas` e o Caddy balanceando; teste de carga mínimo
  (k6 ou script) com 2 réplicas: nenhuma resposta duplicada em 500 conversas simultâneas.

## Fora de escopo
- Kubernetes; banco em alta disponibilidade; multi-região.

## Premissas
- O banco continua único por instalação; a escala é do server, não do Postgres.

## Critérios de aceite
- Com 2 réplicas, o teste de fusão de turno (`turno-fusao.integration.test.ts`) e o de HITL
  passam apontando para as duas; carga de 500 conversas sem resposta duplicada nem turno
  perdido; SSE atualiza o console conectado em qualquer réplica; `grep "new Map" debounce.ts`
  vazio.
