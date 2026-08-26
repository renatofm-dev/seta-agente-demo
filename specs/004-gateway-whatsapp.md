# 004 — Gateway WhatsApp + simulador

## Objetivo
Canal Meta Cloud API funcionando com número de teste, e um simulador dev para desenvolver
e demonstrar sem depender da Meta.

## Escopo
- Setup (manual, documentar em `docs/meta-setup.md`): app Meta tipo Business → produto
  WhatsApp → número de teste + até 5 destinatários verificados; token de acesso; webhook
  apontando para `https://seta.outerlab.com.br/webhook` (011) ou túnel dev
  (`cloudflared tunnel` — documentar comando).
- `packages/wa-meta` + rotas no server:
  - `GET /webhook`: verificação `hub.challenge`.
  - `POST /webhook`: valida assinatura `X-Hub-Signature-256` (HMAC do app secret);
    persiste inbound com `wa_message_id` UNIQUE (upsert ⇒ idempotência de reentrega);
    atualiza `conversa_janela` (última msg do usuário + 24 h); enfileira no debouncer.
    Responde 200 SEMPRE e rápido (processamento é assíncrono).
  - **Debouncer**: pg-boss com `singletonKey = conversaId` e delay 4 s re-agendado a cada
    nova mensagem; no disparo, agrega as mensagens pendentes num único turno (005).
  - **Outbox**: toda resposta vira linha em `outbox` (dedupe key = turnoId+seq); worker
    envia via Graph API com retry exponencial; status de entrega (webhooks `statuses`)
    atualiza `mensagem`.
  - `OutboundGateway.send` falha explícito se janela fechada (POC: só loga e marca o
    ticket — sem template real).
- **Simulador dev** (`DEV_SIMULATOR=true`): `POST /dev/inbound {waId, text}` injeta no
  MESMO caminho do webhook (mesma idempotência, mesmo debounce); página `/simulador` no
  console com chat simples via SSE. É o plano B da demo (000).

## Critérios de aceite
- Reentrega do mesmo `wa_message_id` não duplica mensagem nem turno (teste).
- 3 mensagens em 2 s viram 1 turno agregado (teste com clock do pg-boss).
- Assinatura inválida → 401 sem side effects (teste).
- Ida e volta real no número de teste documentada com screenshot no PR.
