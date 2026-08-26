# 010 — Observabilidade

## Objetivo
Ver o que o agente fez e quanto custou, por conversa — e o trace que prova auditabilidade.

## Escopo
- `packages/observability`: emissor tipado de eventos → tabelas `evento_llm` (turno, modelo,
  tokens in/out do usage do provider, latência), `evento_query` (catalogId+versão, latência,
  linhas, truncado, erro — emitido pelo executor da 003), `evento_guardrail`,
  `evento_escalonamento`. Tudo com traceId/ticketId.
- **Trace viewer** no `/ticket/[id]`: timeline expansível por turno — contexto (skills,
  resumo), tool calls (params → resultado mascarado), verdicts, resposta, tokens, latência.
  É a tela do Ato 4.
- `/metricas`: conversas/dia, taxa de resolução sem humano, escalonamentos por motivo,
  tokens e custo estimado/dia (preço por token no env), p95 de latência de query e de turno.
  Recharts, janela de 7/30 dias.

## Critérios de aceite
- Qualquer turno da demo é reconstituível no viewer sem consultar o banco na mão.
- Métricas batem com um cenário controlado de teste (N conversas → números esperados).
- Overhead de emissão não bloqueia o turno (escrita assíncrona; teste de que falha de
  observabilidade não derruba resposta).
