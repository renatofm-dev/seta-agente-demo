# 029 — Copiloto de cobrança para o atendente

> **Pré-spec / rascunho M5** (08/09/2026): depende do piloto (E-03 do backlog, "copiloto de
> cobrança Bali"). A 014 é a semente; a 017 dá os números. Critérios iniciais.

## Objetivo
Depois do piloto, a equipe de cobrança do cliente vai usar o console todos os dias. Hoje ele
mostra o que aconteceu; o copiloto sugere o que fazer: para cada cotista com parcela vencida,
a próxima ação (lembrar, oferecer PIX, escalar para negociação humana, aguardar), com a
evidência (histórico de campanhas, respostas, cobranças emitidas, tempo desde o último
contato) e um clique para executar pelo agente.

## Reaproveita
- Relatório da 017 (funil por destinatário, janela de atribuição) e as tabelas de cobrança
  da 014.
- `v_inadimplencia`, `titulos_atraso` (catálogo), painel de contexto do inbox (financeiro).
- Disparo individual de template (013) e `enqueueOutbound` fora de turno.
- Skills (009): a sugestão pode ser uma skill de cobrança aprovada pelo curador.

## Escopo
- Tela Cobranças › Carteira: lista de contratos inadimplentes com faixa de atraso, último
  contato, última campanha, resposta, cobrança em aberto e **ação sugerida** (regra
  determinística primeiro; LLM só para redigir a mensagem, nunca para escolher valor).
- Ações: "lembrar agora" (template), "oferecer pagamento" (o agente inicia o fluxo da 014
  na próxima resposta do cotista ou por template com botão de resposta rápida), "marcar
  para negociação" (ticket para humano), "aguardar" (snooze com motivo).
- Registro de cada ação com autor e resultado; o relatório da 017 ganha a dimensão
  "origem: copiloto".
- Régua padrão por faixa (1–30, 31–90, 91–180, >180) configurável no `client.yaml`.

## Fora de escopo
- Negociação automática de desconto (guardrail continua).
- Discador/telefone; e-mail.

## Premissas
- O copiloto sugere, o atendente decide; nada é enviado sem um clique ou sem a régua
  configurada explicitamente pelo gestor.

## Critérios de aceite
- Carteira lista os contratos vencidos do espelho com a sugestão e a evidência; cada ação
  executa pelo caminho já existente (template, fluxo de cobrança, ticket) e fica no
  histórico; relatório mostra conversão por origem.
