# 028 — Adaptador Seven (Winthor): segunda vertical com o mesmo motor

> **Pré-spec / rascunho M5** (08/09/2026): depende do piloto e da decisão comercial de
> abrir a linha Seven. Item P-19 (#58). Critérios iniciais; revisar antes de executar.

## Objetivo
A arquitetura promete que trocar de ERP é trocar o conteúdo (views, catálogo, KB, persona),
não o motor. A 012 provou isso uma vez, trocando distribuidora por multipropriedade. Esta
spec faz o caminho inverso para a linha Seven (ERP Winthor): ressuscita o domínio de
distribuidora do histórico git como um segundo conjunto de conteúdo selecionável por
instalação, sem tocar em `agent`, `guardrails`, `query-catalog`, `wa-meta` ou no console.

## Reaproveita
- Histórico git da 002 (tabelas `pcclient`/`pcpedido`/`pcprest`, views, catálogo e KB de
  distribuidora) — `git log --all -- infra/erp-mock catalog kb` antes da 012.
- `packages/domain-erp` como molde para um `domain-winthor` (tipos canônicos da vertical).
- Layout por cliente da 021 (`configs/<cliente>/{catalog,kb,skills-seed}`).
- 018 (views sobre espelho real; teste de contrato) como padrão.

## Escopo
- `infra/erp-mock-winthor/`: tabelas, views canônicas (`v_cliente`, `v_pedido`,
  `v_titulo`, `v_estoque`…), grants; `pnpm db:seed:erp --vertical winthor`.
- `catalog/winthor/` e `kb/winthor/`; `client.yaml › vertical: multipropriedade | winthor`
  decide persona, catálogo e KB; `domain-winthor` com os status canônicos.
- Fluxo de cobrança da 014 sobre títulos do Winthor (a máquina não muda; os candidatos vêm
  do catálogo da vertical); SDR desligado por default nessa vertical.
- Roteiro de demo Seven (3 atos) e discovery do agente Seven (P-11) como entrada.

## Fora de escopo
- Escrita no Winthor; pedidos pelo WhatsApp (é discovery).
- Multi-vertical na mesma instalação.

## Premissas
- Uma instalação = uma vertical; a escolha é config, não código.
- O motor não ganha `if (vertical)`: o que variar entra por catálogo, KB, persona e views.

## Critérios de aceite
- `client.yaml` com `vertical: winthor` sobe o agente respondendo saldo de títulos e
  status de pedido a partir do mock Winthor, com os mesmos guardrails e HITL.
- `grep -r winthor packages/agent packages/guardrails apps/console` vazio.
- Suíte verde nas duas verticais (matriz no CI).
