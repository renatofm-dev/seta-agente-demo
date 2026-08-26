# 007 — CRM + Console HITL

## Objetivo
O mínimo de CRM para sustentar tickets e o painel onde o humano assume, responde e devolve.

## Escopo
- Modelos Drizzle (banco `app`): `contato` (waId único, nome, vínculo: clienteErpId +
  verificadoEm — populado por seed na POC), `ticket` (status:
  `bot_ativo | aguardando_humano | humano_ativo | resolvido`, atendenteId,
  motivoEscalonamento), `mensagem` (direção, autor: contato|bot|atendente, corpo, waMessageId,
  statusEntrega), `evento_ticket` (toda transição, com ator).
- Máquina de estados como função pura testável; transições inválidas lançam erro.
- Better Auth (email+senha) com papéis `atendente` e `curador`. Seed: 1 usuário de cada.
- Console (Next.js + shadcn):
  - `/inbox`: três filas (bot ativo, aguardando humano — com motivo e tempo de espera,
    meus tickets). Atualização por SSE (fallback polling 3 s).
  - `/ticket/[id]`: conversa ao vivo; ações **assumir** (→ `humano_ativo`, bot silencia),
    **enviar** (via outbox, autor atendente), **devolver ao bot**, **resolver**.
    Painel lateral: dados do cliente ERP (via `cliente.perfil` do catálogo) e último
    motivo de escalonamento.
  - Guarda de rota por papel; `/simulador` (004) atrás de flag dev.
- **Sinal de correção HITL** (insumo da 009): ao assumir um ticket escalado, a primeira
  resposta do atendente é pareada ao último draft bloqueado/à última resposta do bot e
  gravada como `sinal_aprendizado(tipo: correcao_hitl)`.
- API do console no próprio Fastify (`/api/console/*`), sessão Better Auth.

## Critérios de aceite
- Fluxo completo no browser: escalonamento aparece na fila em < 3 s, assumir silencia o
  bot (mensagem do contato durante `humano_ativo` NÃO gera turno — teste), devolver reativa.
- Transições inválidas bloqueadas (testes da máquina de estados).
- Sinal `correcao_hitl` gravado com o par (draft do bot, resposta do humano).
