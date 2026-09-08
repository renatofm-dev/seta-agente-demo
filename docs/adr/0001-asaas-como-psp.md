# ADR 0001 — Asaas como provedor de pagamento (PSP)

- **Status**: aceito (2026-09-02, decisão do Renato)
- **Spec**: 014 — Compra e cobrança pelo WhatsApp

## Contexto

A spec 014 é a primeira funcionalidade que movimenta dinheiro. O ERP (TS Explorer) é
somente leitura por desenho e só expõe linha digitável / PIX de parcelas já emitidas por
ele; não há link de pagamento por cartão nem forma de saber quando o cliente pagou. Para
oferecer **boleto, PIX e cartão** e receber a confirmação, é preciso um provedor de
pagamento externo. `specs/README.md` fixa a stack e diz "nada fora disso sem ADR";
`CLAUDE.md` exige perguntar antes de qualquer dependência de infraestrutura nova.

## Decisão

Usar o **Asaas** (sandbox na POC, produção depois) como PSP, atrás do port
`PaymentProvider` (`packages/payment-provider`), no mesmo padrão dos demais ports
(`AIProvider`, `DbConnector`, `VectorStore`, `SkillRegistry`): interface no pacote,
implementação trocável, provider simulado para dev/testes.

- Integração por HTTP com `fetch` nativo — **sem SDK e sem dependência npm nova**.
- Uma cobrança única por conjunto de parcelas, `externalReference` determinística
  (`contrato:{id}:titulos:{ids}`), consulta antes de criar.
- Webhook autenticado por token (`asaas-access-token`), idempotente pelo id do evento.
- Ambiente derivado da base URL e logado no boot — sandbox e produção nunca se confundem.

## Alternativas consideradas

- **Só o que o ERP já tem** (linha digitável e PIX de `v_titulo`): não cobre cartão, não
  confirma pagamento, e as parcelas vencidas nem trazem esses campos no catálogo.
- **Pagar.me / Mercado Pago / Stripe**: viáveis; Asaas foi escolhido por ter boleto, PIX e
  link de cartão numa única cobrança, sandbox aberto, webhook simples por token e
  `receiveInCash` para simular recebimento. Trocar de PSP = novo adapter do port.
- **Escrever a baixa no ERP mock**: rejeitado — quebraria a fronteira read-only que as
  specs 002/003 estabelecem em três camadas. A baixa fica na tabela `pagamento` do banco
  `app`, e uma camada de conciliação faz as leituras refletirem o pagamento.

## Consequências

- Dependência operacional nova (conta, chave, webhook público) — registrada em
  `docs/status-do-projeto.md` como decisão dos sócios.
- Dados de cartão **nunca** passam pelo sistema (só link) — mantém a POC fora de PCI-DSS.
- Chave de sandbox ≠ produção: `.env` separado por ambiente; o log de boot mostra qual
  está ativo.
- O webhook precisa de URL pública; em dev, o túnel do `pnpm dev-whatsapp` registra o
  webhook do Asaas no sandbox e o desliga ao sair.
