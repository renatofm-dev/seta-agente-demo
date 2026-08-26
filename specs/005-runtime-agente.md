# 005 — Runtime do agente (LangGraph)

## Objetivo
O loop do turno: contexto → LLM com tools → resposta, com limites, trace completo e
provedor trocável.

## Escopo
- `packages/ai-provider`: port fino
  `AIProvider { modelId; chat(req): Promise<ChatResponse>; embed(texts): Promise<Float32Array[]> }`
  Impl única: cliente OpenAI-compatible com `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
  `EMBEDDING_MODEL` (funciona com OpenAI/OpenRouter hoje e vLLM on-prem amanhã — argumento
  de venda; validar na escolha do provedor que tool calling funciona bem).
- `packages/agent`: StateGraph com nós:
  1. `montar_contexto`: persona da config + estado do ticket + resumo rolante + últimas N
     mensagens + skills top-k (009; até lá, stub que retorna []) + tools (catálogo via 003
     + `buscar_conhecimento` da 008 + tool `escalar_para_humano`).
  2. `agente`: loop LLM⇄tools nativo do LangGraph. Budget: máx. 6 tool calls/turno,
     timeout de turno 60 s, 1 retry por tool falha; estourou → caminho de fallback.
  3. `guardrails_saida`: hooks da 006 sobre o draft (allow/rewrite/block/escalate).
  4. `responder`: grava resposta, empurra pra outbox, atualiza resumo rolante
     (sumarização barata a cada K turnos).
- Fallback (sem dado, sem caminho, budget estourado): admite não saber + oferece humano
  (nunca inventa). Se `ticket.status != bot_ativo`, runtime não responde (007).
- **Trace**: `trace_turno` persistido SEMPRE — contexto montado (ids de skills, resumo),
  tool calls com params e resultado mascarado, verdicts, resposta, tokens, latências.
- Prompt-base versionado em `packages/agent/prompts/` (arquivo, não string inline).

## Critérios de aceite
- Via simulador: pergunta de boletos → tool certa → resposta com dados do seed.
- Pergunta sem caminho de dado → admite não saber e oferece humano (teste de replay).
- Budget: cenário que estoura 6 tool calls cai no fallback (teste com provider fake).
- `trace_turno` de qualquer turno reconstitui a decisão inteira (verificar no viewer da 010).
- Provider fake em `packages/ai-provider/testing` para testes determinísticos do grafo.
