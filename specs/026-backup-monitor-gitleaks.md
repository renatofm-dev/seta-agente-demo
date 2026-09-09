# 026 — Backup automático, monitor de disponibilidade e varredura de segredos

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Marco M2 (restante: P-34, I-04,
> I-12 do roadmap). Não depende de decisão; é o ponto de entrada do dev pleno no repositório.
> Executa antes das specs 018+, apesar do número.

## Objetivo
O homelab tem backup manual e nunca restaurado, ninguém é avisado se o agente ficar mudo, e
segredos só são barrados pela validação de env em produção (P-28). Antes de expor o sistema
a tráfego real, três garantias: **um backup que comprovadamente restaura**, **um alerta em
menos de cinco minutos de silêncio**, e **nenhum segredo entra no histórico**.

## Reaproveita
- `docs/deploy-homelab.md` e `infra/compose.prod.yml` (serviço `db`, volume do Postgres).
- `app.ts:81` `/healthz` (`status`, `cliente`, `uptimeSegundos`).
- `apps/server/src/wa/dev-routes.ts` `POST /dev/inbound` (exige sessão) e o simulador —
  a mensagem periódica de teste passa pelo caminho inteiro (fila, turno, outbox).
- `.github/workflows/ci.yml`; regras do gateway (`seta-gestao#17`, backlog V2 §8 passo 5)
  como referência para gitleaks e `pnpm audit`.
- Slack: canal `#dev-alertas` (backlog V2).

## Escopo

### Backup (`infra/backup/`)
- `backup.sh`: `pg_dumpall` do container `db` para `/var/backups/seta/<data>.sql.gz`,
  retenção de 7 diários + 4 semanais, log de tamanho e duração; cron do host às 03:00
  (documentado no `deploy-homelab.md`).
- `restore.sh <arquivo>`: sobe um Postgres efêmero (`compose.backup.yml`), restaura e roda
  três verificações: `select count(*)` em `documento`, `contato` e `cobranca` batendo com o
  manifesto gravado no backup; migrações no mesmo `idx` do `_journal.json`.
- `infra/backup/README.md` com o runbook de restauração completa (parar server → restaurar
  → migrar → subir).

### Monitor (`infra/monitor/` + job no server)
- Probe externo (cron no host ou uptime-kuma no compose, decisão na execução): `GET
  /healthz` a cada minuto; 3 falhas seguidas ⇒ mensagem no `#dev-alertas` via webhook do
  Slack (`SLACK_ALERTAS_WEBHOOK` no `.env.prod`).
- Sonda funcional: a cada 5 min, `POST /dev/inbound` com o número `5511999990099` (reservado
  no `contatos.yaml` de demo como "sonda") e texto fixo; o server registra o `trace_turno`;
  o probe consulta `GET /api/console/sonda` (nova, só leitura) que devolve o horário do
  último turno da sonda; silêncio > 5 min ⇒ alerta. Em produção o número da sonda é o do
  próprio cliente (023) e a mensagem é um template de utilidade.
- `/healthz` ganha `ultimoTurnoEm` e `filas` (jobs ativos/falhados por fila) — barato e
  útil no alerta.

### Segredos
- `gitleaks` no pre-commit (`lefthook` ou `simple-git-hooks`, escolher a que já está no
  gateway) e no `ci.yml` (`gitleaks/gitleaks-action`) com `.gitleaks.toml` mínimo
  (allowlist para `.env.example` e fixtures).
- `pnpm audit --audit-level=high` no CI (falha em `high`/`critical`, com allowlist
  documentada).
- Varredura do histórico (`gitleaks git`) antes da transferência para a org (P-12).

## Fora de escopo
- Cofre de segredos, rate limit, dead-letter (022).
- Métricas de negócio no alerta (o relatório da 017 cobre).
- Backup do espelho do ERP (é do cliente).
- Alta disponibilidade e réplicas (034).

## Premissas
- O homelab é um servidor pequeno (2 vCPU / 4 GB): backup comprimido e restauração em
  container efêmero cabem; o teste de restore roda semanal, não diário.
- O webhook do Slack é o canal de alerta; e-mail fica de fora.
- A sonda usa o simulador **atrás de sessão**: o probe faz login com um usuário `sonda`
  (papel atendente) criado pelo seed.

## Critérios de aceite
- `backup.sh` gera o arquivo, aplica a retenção e loga; `restore.sh` restaura num banco
  limpo e as três contagens batem — executado ao menos uma vez no homelab, com o log no PR.
- Derrubar o server por 5 min ⇒ mensagem no `#dev-alertas`; subir ⇒ mensagem de recuperação.
- Sonda: parar o worker de debounce ⇒ alerta em ≤ 6 min mesmo com `/healthz` respondendo.
- Commit com `ASAAS_API_KEY=abc…` é recusado pelo pre-commit; PR com segredo falha no CI.
- `pnpm audit` roda no CI; `pnpm lint && pnpm test && pnpm build` verdes.
