# 006 — Guardrails

## Objetivo
Impor as políticas por arquitetura (capacidade ausente + hooks verificáveis), não por
instrução textual.

## Escopo
- `packages/guardrails`: pipeline de hooks
  `beforeTool(call) / afterTool(result) / beforeReply(draft)` retornando
  `Verdict = allow | rewrite{patch} | block{reason} | escalate{trigger}`.
  Todo verdict != allow entra no trace e vira `sinal_aprendizado` (009).
- **Preço** (o guardrail da demo):
  - Estrutural: nenhuma tool cota livre; valores só via `preco.tabela_vigente`.
  - `beforeReply`: extrai valores monetários do draft (regex R$/percentual); todo valor
    precisa ser rastreável a resultado de tool `price_source` DO turno; valor órfão ou
    draft prometendo desconto/condição especial → `block + escalate(negociacao_preco)`.
  - Classificador de intenção no inbound (chamada curta ao LLM, saída estruturada:
    `negociar_preco | tema_sensivel | pedir_humano | outro`) → escala antes de responder.
- **Gatilhos de escalonamento**: pedido explícito; intenção de negociação; tema sensível
  (lista na config do cliente); 2 falhas de tool no turno. Escalar = ticket →
  `aguardando_humano` + motivo + mensagem de transição ao contato.
- Config do cliente define listas (temas sensíveis) — mecanismo genérico, política por config.

## Critérios de aceite
- Replay: "me dá 10% de desconto?" → nenhum valor prometido, ticket escalado com motivo
  `negociacao_preco` (teste com provider fake forçando draft com desconto → block).
- Draft com "R$ 123,45" não vindo de tool do turno é bloqueado (teste unitário do hook).
- Todos os verdicts aparecem no trace do turno.
