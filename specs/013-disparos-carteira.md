# 013 — Disparos de template para a carteira

## Objetivo
Hoje o sistema só REAGE: o cotista fala, o agente responde. Esta spec adiciona o caminho
ativo — disparar mensagens de template para a carteira de clientes vinculada, com os
modelos criados e aprovados **direto da plataforma**, via API oficial da Meta (WhatsApp
Business Management API). Reverte, agora com fundamento, o corte da 004 ("sem template
real"): template aprovado é a ÚNICA forma de iniciar conversa fora da janela de 24h.

## Escopo

### `packages/wa-meta` — modelos e envio de template
- `TemplateApi` (port, no padrão dos demais): `criar(def)` e `listar()` contra
  `/{WABA_ID}/message_templates` da Graph API. Definição validada com Zod:
  nome `^[a-z0-9_]+$`, idioma (default `pt_BR`), categoria `marketing|utility`,
  corpo com variáveis posicionais `{{1}}..{{N}}` sequenciais, rodapé opcional.
- `OutboundGateway.sendTemplate({to, nome, idioma, variaveis})`: envio de template pelo
  `/{PHONE_ID}/messages` — **sem exigência de janela** (é o propósito do template).
  O gateway de log (dev/simulador) implementa o mesmo contrato.
- Env novo: `WA_WABA_ID` (id da WhatsApp Business Account). Sem ele, as rotas de modelo
  respondem 503 com explicação; o restante do sistema não muda.

### Banco (`apps/server`, migração 0013)
- `modelo_mensagem`: espelho local do template — nome (unique), idioma, categoria,
  corpo, rodapé, `meta_id`, `status_meta` (`pendente|aprovado|rejeitado|desconhecido`),
  motivo de rejeição, criado por.
- `disparo`: modelo usado, valores das variáveis (JSONB, globais ao disparo), status
  (`enviando|concluido`), criado por.
- `disparo_destinatario`: um por contato — `wa_id`, status
  (`pendente|enviado|entregue|lido|falha`), `wa_message_id`, erro.
- `mensagem.autor` ganha `campanha`: o disparo aparece na thread da conversa do console
  (criando a conversa se não existir) — quando o cliente responder, o fluxo normal
  (turno → agente, #47) assume.

### Server
- Rotas `/api/console/modelos` (listar com sync de status na Meta; criar — persiste
  local E registra na Meta) e `/api/console/disparos` (listar; criar escolhendo modelo
  APROVADO + valores de variáveis + contatos da carteira; detalhe com contagem por
  status). Carteira = tabela `contato` (vínculos verificados).
- Worker `FILA_DISPARO` (pg-boss): consome o disparo, envia sequencialmente via
  `sendTemplate`, grava a mensagem `out` (autor `campanha`) na conversa e atualiza o
  destinatário; falha em um destinatário marca só ele (`falha` + erro) e segue.
- Webhook de status: além de `mensagem`, atualiza `disparo_destinatario` pelo
  `wa_message_id` (sent/delivered/read/failed).

### Console
- Página **Disparos** no nav: seção de modelos (criar + lista com status de aprovação
  da Meta e botão de sincronizar) e seção de disparos (criar + lista + detalhe com
  progresso por status).

## Fora de escopo
- Segmentação da audiência por dados do ERP (ex.: "só inadimplentes" via catálogo) —
  a seleção é manual sobre a carteira; segmentação é evolução natural em outra spec.
- Agendamento de disparo, templates com header de mídia/botões (só BODY + FOOTER texto),
  personalização de variável por destinatário (valores são globais ao disparo),
  métricas de campanha no `/metricas`, opt-out/lista de supressão.
- Webhook de atualização de status de TEMPLATE (`message_template_status_update`) —
  o sync é por polling manual (botão) na POC.

## Premissas
- Qualquer papel logado (atendente/curador) cria modelo e dispara — POC sem papel
  "marketing"; registrar evolução.
- Categoria default `utility`; a Meta pode recategorizar para `marketing` na aprovação —
  o sync reflete.
- Disparo só com modelo `aprovado` (400 caso contrário).

## Critérios de aceite
- Criar modelo pela plataforma registra na Meta (fake nos testes) e persiste local com
  `status_meta = pendente`; sincronizar reflete aprovado/rejeitado (com motivo).
- Disparo com modelo não aprovado → 400.
- Disparo para N contatos cria N destinatários; o worker envia a todos MESMO com a
  janela de 24h fechada, grava mensagem `campanha` na thread (criando conversa quando
  não existe) e o detalhe mostra a contagem por status.
- Falha de envio em um destinatário não impede os demais.
- Status do webhook (delivered/read) atualiza destinatário e mensagem.
- Resposta do cliente ao disparo entra no fluxo normal (vira turno e o agente atende).
- `pnpm lint && pnpm test && pnpm build` verdes.
