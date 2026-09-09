# 030 — Campanha segmentada: segmentação, agendamento, opt-out e variável por destinatário

> **Pré-spec / rascunho M5** (08/09/2026): reúne o "fora de escopo" da 013 e da 017 e o
> E-04 restante do backlog. Depende do piloto e da 023 (WABA real, volume).

## Objetivo
A campanha de hoje é "escolha contatos da carteira à mão, escolha um modelo, envie agora".
O design do console já desenha o alvo: segmentar por faixa de atraso, tipo de parcela e
saldo mínimo, excluir automaticamente opt-out, distrato e quem recebeu campanha há poucos
dias, agendar, controlar o ritmo, personalizar a variável por destinatário, e ver o
relatório chegar sozinho.

## Reaproveita
- Wizard de campanha (`campanhas/nova/page.tsx`, 4 passos no design), `disparos-routes.ts`,
  worker de disparo, `funilDe`, relatório da 017 (`relatorios-routes.ts`).
- Catálogo (`titulos_atraso`, `v_inadimplencia`) para segmentar com dado do ERP.
- `contato` (vínculo), `disparo_destinatario`.

## Escopo
- **Segmentação** via catálogo: entradas `campanhas.*` com `source: session` = instalação
  (faixa de atraso, tipo de parcela, saldo mínimo, produto/bloco) e prévia de elegíveis;
  exclusões automáticas: opt-out, distrato em análise, campanha nos últimos N dias, cobrança
  em aberto gerada pelo agente.
- **Opt-out / lista de supressão**: `optout` (wa_id, origem: `SAIR` no WhatsApp, console,
  eliminação da 024); o worker de disparo e o SDR respeitam; relatório mostra opt-outs
  gerados por campanha (KPI do design).
- **Agendamento e ritmo**: `disparo.agendado_para`, envio em lotes por minuto, pausa e
  retomada; aprovação de gestor para campanhas acima de N destinatários.
- **Variável por destinatário**: valores vindos do catálogo (nome de exibição, parcela,
  valor) — nunca da LLM.
- **Templates** com header de mídia e botões de resposta rápida (a Meta exige categoria
  certa); webhook `message_template_status_update` (se a 023 não tiver feito).
- **Relatório** (017): envio automático semanal para Slack/e-mail com o CSV; competência
  financeira (mês de vencimento) como filtro adicional; relatórios de cobrança e de
  atendimento no mesmo padrão.

## Fora de escopo
- Prospecção de leads frios por campanha (031).
- Editor de template visual (Meta já tem).

## Premissas
- Opt-out é absoluto para mensagens proativas; o atendimento reativo continua.
- O rate limit da Meta por faixa de conversa (023) é respeitado pelo ritmo.

## Critérios de aceite
- Campanha "31–90 dias, saldo ≥ R$ 500, excluir opt-out e campanha há 7 dias" gera a lista
  certa a partir do ERP; agendada para amanhã 9h sai no horário em lotes; "SAIR" registra
  opt-out e o próximo disparo pula o número; relatório semanal chega no canal com o CSV.
