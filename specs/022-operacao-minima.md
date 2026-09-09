# 022 — Operação mínima: rate limit, dead-letter inspecionável, cofre e retenção de logs

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende da 026 (monitor e
> backup) e conversa com a 021 (cofre junto com a instalação por cliente). Item P-40, marco M4.
> Cobre a "Fase C — preparar a operação" do `status-do-projeto.md`, item a item.

## Objetivo
O sistema aguenta o protótipo, não tráfego hostil nem um dia ruim: os webhooks não têm
limite de taxa, a última tentativa de envio vira dead-letter que só aparece no log, os
segredos vivem num `.env.prod` e os logs crescem sem política. Esta spec entrega o mínimo
para operar um piloto com tranquilidade e um runbook para quem estiver de plantão.

## Reaproveita
- `apps/server/src/wa/routes.ts` (`/webhook`, HMAC), `pagamentos/webhook-routes.ts`
  (`/webhooks/asaas`, token), `wa/dev-routes.ts`.
- `boss.ts` (`retryLimit`, dead-letter no log — #29), `wa/outbox.ts` (marca o ticket na
  falha definitiva), `varrerPendentesOrfas`.
- `/healthz` com filas (026), `docs/dev/07-operacao-e-deploy.md › Runbook mínimo`.
- Fastify: `@fastify/rate-limit` é plugin oficial (não é dependência de infra; registrar no
  `CLAUDE.md` como aprovada se entrar).

## Escopo

### Proteção dos webhooks
- Rate limit por IP e por rota em `/webhook` (GET e POST), `/webhooks/asaas` e `/api/auth/*`
  (login): limites conservadores (Meta e Asaas vêm de poucos IPs; login 10/min por IP).
  Excedente ⇒ 429 sem side effect; contagem no `/healthz`.
- Tamanho máximo de corpo nos webhooks (1 MB) e nas rotas de console (256 KB).
- `x-hub-signature-256` continua obrigatório; falha de assinatura passa a contar para o
  rate limit (10 em 1 min ⇒ bloqueio de 10 min do IP).

### Dead-letter
- Tabela `dead_letter` (fila, job, payload, erro, tentativas, `criado_em`,
  `reprocessado_em`): o `onComplete`/falha definitiva de cada fila grava ali, além do log.
- `GET /api/console/operacao/dead-letter` (papel curador) lista; `POST …/:id/reprocessar`
  reenfileira com o mesmo payload; `POST …/:id/descartar` com motivo.
- Tela Configurações › Operação: filas (ativos, falhados), dead-letter com ações, último
  backup (026), versão (021). Só leitura fora do que está acima.

### Segredos
- Cofre: `sops` + `age` (arquivo `secrets.enc.yaml` por cliente no repo, chave só no host e
  no cofre da empresa) **ou** o secret manager do provedor se a instalação for na nuvem do
  cliente — decisão na execução, registrada em ADR 0003. `deploy.sh` decripta para o
  `.env.prod` em memória/tmpfs; nada em texto claro no disco fora do momento do deploy.
- Rotação documentada: `BETTER_AUTH_SECRET`, `WA_APP_SECRET`, `ASAAS_WEBHOOK_TOKEN`, senhas
  do Postgres, chave do LLM.

### Logs
- pino para stdout com rotação pelo Docker (`json-file`, `max-size`/`max-file` no
  `compose.prod.yml`, 7 dias) ou `logrotate` no host; nível `info` em produção; PII não
  entra em log (a anonimização cobre o que sai para a LLM; aqui é o que fica: `texto` de
  mensagem só em `debug`).
- Retenção de `evento_*` e `trace_turno` fica com a 024 (política LGPD), não aqui.

### Runbook (`docs/dev/07-operacao-e-deploy.md`)
- Plantão: o que checar (healthz, filas, dead-letter, último backup), como reprocessar,
  como rotacionar um segredo, como fazer rollback (021), quem avisar.

## Fora de escopo
- WAF, DDoS, CDN; alta disponibilidade (034).
- Métricas de infraestrutura (CPU, memória) — o servidor pequeno é decisão de D3.
- Retenção de dados de negócio (024).

## Premissas
- Meta e Asaas re-tentam webhooks recusados com 429; o limite nunca deve barrar o tráfego
  legítimo do piloto (dimensionar com folga de 10×).
- Reprocessar um dead-letter é idempotente porque as filas já são (outbox por chave,
  eventos do PSP por `evento_psp.id`).

## Critérios de aceite
- 100 POSTs em `/webhook` em 10 s de um IP ⇒ os excedentes recebem 429 e nada é gravado;
  tráfego normal do teste de integração passa.
- Falha definitiva do outbox aparece em `dead_letter` e na tela; reprocessar reenvia e
  limpa; descartar registra o motivo.
- `deploy.sh` sobe sem `.env.prod` em texto claro persistido; rotação de
  `ASAAS_WEBHOOK_TOKEN` documentada e testada (webhook antigo ⇒ 401).
- Logs rotacionados no host; nenhum texto de mensagem em `info`.
- Runbook revisado por quem não escreveu; `pnpm lint && pnpm test && pnpm build` verdes.
