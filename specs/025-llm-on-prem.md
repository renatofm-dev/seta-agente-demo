# 025 — LLM dentro da rede do cliente (vLLM)

> **Pré-spec condicional** (rascunho de 08/09/2026): executa **só se a D6 negar** a saída
> de dado pseudonimizado para a Anthropic. Item P-35, marco M4; custa pelo menos duas
> sprints e um servidor com GPU no cliente.

## Objetivo
O `AIProvider` foi desenhado para trocar de fornecedor sem reescrever: endpoint
OpenAI-compatible, `LLM_BASE_URL` e `LLM_MODEL`. Se o cliente não permitir dado saindo da
rede, o provedor passa a ser um vLLM (ou equivalente) dentro da infraestrutura dele. O
risco não é a troca de URL: é o modelo aberto sustentar tool calling estruturado, o
classificador de intenção e os intérpretes de fallback com a mesma confiabilidade.

## Reaproveita
- `packages/ai-provider/src/openai-compatible.ts` (chat com tools, embed).
- `FakeAIProvider` e a suíte de integração inteira: é o critério de aceite.
- `packages/anonimizacao`: continua ligada (defesa em profundidade), mesmo com a LLM interna.
- 019 (embeddings): modelo de embedding local no mesmo servidor.

## Escopo

### Validação do modelo (antes de qualquer código)
- Bancada: rodar a suíte de integração com `LLM_BASE_URL` no vLLM e um modelo candidato
  (Qwen 2.5/3 Instruct, Llama 3.x, Mistral — o que couber na GPU) e medir: taxa de tool
  call válido, aderência ao JSON do classificador (`intencao.ts`) e dos intérpretes
  (`cobranca/interpretar.ts`, `sdr/interpretar.ts`), latência p95, custo por turno.
- Relatório em `docs/llm-on-prem-<data>.md` com a decisão de modelo e o hardware.

### Código
- `ai-provider`: `tool_choice`, `response_format: json_schema` quando o servidor suportar;
  retry com backoff em 5xx; `max_tokens` por chamador (o classificador é curto).
- Prompts (`agent/prompt.ts`, `intencao.ts`, intérpretes, `distiller-prompt.ts`) revisados
  para o modelo escolhido, com os mesmos testes.
- Env: `LLM_BASE_URL` interno, `LLM_API_KEY` opcional, `LLM_TIMEOUT_MS`; `/healthz` mostra
  o provedor e o modelo.

### Infra (do cliente)
- vLLM em container com o modelo quantizado, GPU dimensionada para o p95 do piloto;
  `compose.llm.yml` de referência; monitor (026) cobre o endpoint.

## Fora de escopo
- Fine-tuning; treinar com dados do cliente.
- Trocar o provedor para a instalação de demonstração (continua na Anthropic).

## Premissas
- A anonimização (016) continua ligada: o provedor interno também é um sistema com logs.
- Se nenhum modelo aberto passar na bancada com folga, a resposta para a D6 é "não dá
  para o piloto sem a Anthropic", e a decisão volta para os sócios.

## Critérios de aceite
- Suíte de integração verde com `LLM_BASE_URL` no vLLM (sem `skip`), incluindo cobrança,
  SDR, guardrails e aprendizado.
- Roteiro de demo (5 atos + Ato 6) executado com o modelo interno, com latência p95 dentro
  de 2× a atual.
- Relatório de bancada no repo; `pnpm lint && pnpm test && pnpm build` verdes.
