# 027 — Asaas em produção: cobrança real no piloto

> **Pré-spec condicional** (rascunho de 08/09/2026): executa **só se a D1 disser sim**
> (pagamentos entram no piloto; teto definido; Asaas aceito). Depende da 024 (base legal do
> CPF) e da 023 (template de confirmação real). Item P-43, marco M4.

## Objetivo
A 014 está completa e testada, mas só com o PSP simulado e o sandbox do Asaas. Ligar
produção é a primeira ação da plataforma com efeito financeiro real: a chave muda, o
webhook precisa ser público e autenticado, o CPF precisa de base legal, e o teto sem
aprovação humana começa baixo e sobe com evidência.

## Reaproveita
- `packages/payment-provider/asaas.ts` (`ambienteDaUrl`: a base URL decide sandbox ou
  produção; o boot loga), `docs/asaas-setup.md`, ADR 0001.
- `env.ts`: `ASAAS_BASE_URL`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` (≥ 32 chars),
  `PAGAMENTO_TETO_SEM_HITL_CENTAVOS`, `PAGAMENTO_MAX_COBRANCAS_DIA`.
- `pagamentos/webhook-routes.ts` (token no header, evento idempotente),
  `cobrancas-routes.ts` (aprovar/recusar), Console › Cobranças.
- 022 (rate limit e cofre), 026 (alerta).

## Escopo

### Conta e chaves
- Conta de produção do cliente (ou da SETA como subconta — decisão comercial na D1);
  chave no cofre (022); `ASAAS_BASE_URL=https://api.asaas.com/v3`; boot loga
  `psp: asaas (producao)` e o console tira o aviso amarelo.
- Webhook público na instalação (021) com `ASAAS_WEBHOOK_TOKEN` rotacionável; e-mail de
  alerta do Asaas (`ASAAS_WEBHOOK_EMAIL`) apontando para a operação.

### Rollout com rede de proteção
- Semana 1: `PAGAMENTO_TETO_SEM_HITL_CENTAVOS` = 0 (toda cobrança passa por aprovação
  humana); `PAGAMENTO_MAX_COBRANCAS_DIA` = 1. Métrica diária: cobranças emitidas, pagas,
  falhas, tempo até aprovação.
- Semana 2+: teto sobe para o valor da D1 se não houver incidente; limite por dia para 3.
- Kill switch: `modulos.pagamentos: false` no `client.yaml` + redeploy desliga o fluxo;
  o agente volta a escalar "quero pagar".

### Conciliação e baixa
- A baixa continua em `pagamento` (ERP read-only); relatório diário de conciliação
  (cobranças pagas no Asaas × registradas) exportável para o financeiro do cliente
  (CSV, no molde do relatório da 017). Baixa automática no ERP fica para quando o cliente
  liberar escrita (fora deste plano).

### Documento do titular
- Só cobra quem tem `contato.documento` com base legal (024); sem isso, escala como hoje.

## Fora de escopo
- Split, antecipação, cartão recorrente, negociação (fora da 014 também).
- Dados de cartão na plataforma (nunca).
- Baixa no ERP real.

## Premissas
- O Asaas de produção exige documento válido do pagador e webhook público com HTTPS: 021 e
  022 vêm antes.
- Um erro de valor é impossível por construção (valor vem do ERP), mas cobrança duplicada
  ou para o contrato errado precisa do teto zero na primeira semana para ser pega por gente.

## Critérios de aceite
- Cobrança real de valor baixo (parcela de teste acordada com o cliente) emitida, paga e
  conciliada, com a confirmação chegando pelo template real.
- Boot loga `producao`; console sem aviso de PSP simulado; `simular-pagamento` responde 404
  em produção.
- Teto zero na primeira semana comprovado pelo log de aprovações; relatório de
  conciliação exportado e conferido pelo financeiro do cliente.
- Kill switch testado (desliga e o agente escala); `pnpm lint && pnpm test && pnpm build`
  verdes.
