# 014 — Compra e cobrança pelo WhatsApp (pagamento de ponta a ponta)

## Objetivo
Hoje, quando o cotista diz "quero comprar/pagar", o agente escala para humano. O agente
sabe dizer que existe parcela vencida (`titulos_atraso`), mas não fecha o ciclo: não emite
cobrança, não oferece cartão, não sabe quando o cliente pagou
(`docs/status-do-projeto.md`, "falta o passo que fecha o ciclo: cobrar"). Esta spec entrega
o fluxo de ponta a ponta: verificar pendências do contrato, oferecer **boleto / PIX / link
de cartão**, emitir a cobrança num PSP (Asaas, ADR 0001), enviar pelo WhatsApp, receber a
confirmação de pagamento por webhook e registrar a **baixa numa tabela nossa**, simulando o
que o ERP faria — o ERP continua somente leitura por desenho (002/003/012).

É a primeira ação do sistema com efeito no mundo real e dinheiro envolvido. Por isso o
desenho é deliberadamente conservador: o LLM **nunca** decide valor, o cliente confirma
explicitamente, há teto de valor com aprovação humana, limite diário, idempotência em três
camadas e bloqueio para contrato cancelado ou em distrato.

## Escopo

### `packages/payment-provider` — port `PaymentProvider` + Asaas + simulado
- Port no padrão dos demais (`AIProvider`, `DbConnector`): `garantirCliente`,
  `criarCobranca`, `buscarPorReferencia`, `cancelarCobranca`, `obterPix`,
  `obterLinhaDigitavel`, `simularRecebimento`, `health`. Valores **em centavos** na
  fronteira; conversão para reais só na borda do adapter.
- `createAsaasProvider` via `fetch` nativo (sem SDK, sem dep npm nova): header
  `access_token`, `User-Agent`, timeout por chamada. Erros tipados: `PspAuthError`
  (401/403), `PspBusinessError` (4xx com a descrição do Asaas), `PspUnavailableError`
  (5xx/rede/timeout) — nunca `Error` genérico.
- `createSimulatedPaymentProvider`: dev/testes sem Asaas (ids determinísticos, links e
  códigos fictícios). Sem `ASAAS_API_KEY` o boot usa o simulado e loga `psp: simulado`.

### `packages/cobranca` — agente de cobrança (domínio puro, sem banco)
- Máquina de estados do fluxo (`selecao → metodo → confirmacao → encerrado`), parser
  determinístico das respostas (número, "todas", boleto/pix/cartão, sim/não/cancelar) e
  `interpretarResposta` (chamada curta ao LLM com saída JSON validada) só quando o parser
  não resolve. Textos pt-BR renderizados com dados do ERP. Regras: teto sem HITL, máximo
  de cobranças por conversa/dia, bloqueio por contrato cancelado/distrato em análise,
  exigência de CPF no vínculo.
- `referenciaExterna(contrato, títulos)` determinística — a chave de idempotência no PSP.

### Banco (`apps/server`, migração 0014)
- `fluxo_cobranca` (1 ativo por conversa), `cobranca` (status
  `aguardando_aprovacao|emitindo|emitida|paga|expirada|cancelada|recusada|falha|estornada`,
  unique parcial por `referencia_externa` enquanto aberta), `cobranca_titulo`,
  **`pagamento`** (espelho da baixa que o ERP faria), `evento_psp` (idempotência do
  webhook pelo id do evento), `psp_cliente`, `contato.documento` (CPF do titular).

### Server
- Classificador de intenção ganha `pagar` (inicia o fluxo, não escala) e `comprar_cota`
  (escala com trigger `interesse_compra` e texto próprio).
- Turno: fluxo ativo na conversa consome o turno; abandono (2 respostas não entendidas)
  devolve ao agente geral no mesmo turno. Agente geral ganha a tool interna
  `iniciar_pagamento` e a tool de leitura `cobranca_em_aberto`.
- Worker `cobranca-emitir` (pg-boss, retry): cliente no PSP → busca por referência →
  cria cobrança → PIX/linha digitável → `emitida` → mensagens no outbox. Falha de auth/
  negócio: sem retry, `falha` + ticket + mensagem honesta.
- `POST /webhooks/asaas`: `asaas-access-token` em tempo constante, `evento_psp`
  idempotente, 200 imediato, processamento na fila `cobranca-evento`
  (`paga` + `pagamento` + aviso ao cotista; vencida/cancelada/estornada).
- **Conciliação**: decorator do `Executor` que faz `financeiro.*` refletir os `pagamento`
  (títulos pagos somem de `titulos_atraso`, agregados recalculados, `saldo_contrato` e
  `total_pago` ajustados). Em produção o ERP faz a baixa e esta camada desaparece.
- Console: `/api/console/cobrancas` (listar, detalhe, aprovar, recusar);
  `POST /dev/pagamentos/:id/simular-pagamento` (DEV_SIMULATOR).
- Env: `ASAAS_BASE_URL`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`,
  `PAGAMENTO_TETO_SEM_HITL_CENTAVOS`, `PAGAMENTO_MAX_COBRANCAS_DIA`,
  `PAGAMENTO_DIAS_VENCIMENTO`, `PAGAMENTO_FLUXO_EXPIRA_MIN`,
  `WA_TEMPLATE_PAGAMENTO_CONFIRMADO`. `client.yaml`: `modulos.pagamentos`.

### Console
- Página **Cobranças**: lista com status, contato, contrato, parcelas, valor, método e
  links; aprovar/recusar as que aguardam aprovação; "Simular pagamento" em dev.

## Fora de escopo
- **Dados de cartão** — em nenhuma hipótese o sistema recebe, trafega ou armazena número
  de cartão; só o link do PSP (fora de PCI-DSS).
- Baixa no ERP real, conciliação bancária, split, antecipação.
- Régua/cobrança proativa (lembrete de vencimento em massa), negociação/desconto/
  parcelamento/renegociação (guardrail de preço permanece; spec 012).
- Venda de cota nova (o pedido vira escalada `interesse_compra` para o comercial).
- Botões interativos, listas, envio de PDF (canal só texto + template, 013).

## Premissas
- "Compra" = o cotista pagar/quitar parcelas existentes do contrato.
- Asaas exige CPF; o ERP não o expõe ao `erp_ro` (LGPD). Na POC o CPF entra no vínculo
  (`contatos.yaml` → `contato.documento`); em produção viria do cadastro com base legal.
- Mensagens do fluxo são determinísticas (dados do ERP), não rascunhos do LLM.
- Vencimento da cobrança no PSP = hoje + `PAGAMENTO_DIAS_VENCIMENTO` (parcela vencida
  precisa de boleto pagável); o vencimento original fica em `cobranca_titulo`.
- Uma cobrança pode cobrir várias parcelas ("todas as vencidas"); a baixa é por título.

## Critérios de aceite
- "quero pagar" do número inadimplente lista as parcelas vencidas + a próxima; "1" → método;
  "2" → confirmação com total; "sim" → cobrança emitida pelo worker e 2 mensagens (texto +
  código PIX) no outbox; valores idênticos aos do ERP.
- Pagamento (webhook ou simulação) marca a cobrança `paga`, grava 1 `pagamento` por título
  e avisa o cotista; em seguida `titulos_atraso` não lista mais o título pago e o resumo
  de inadimplência é recalculado.
- Contrato cancelado/em distrato → bloqueio + ticket `aguardando_humano`
  (`cobranca_bloqueada`); vínculo sem CPF → mesmo caminho.
- Total acima do teto → `aguardando_aprovacao` + ticket (`aprovacao_cobranca`); aprovar no
  console emite; recusar encerra.
- Pedir duas vezes as mesmas parcelas não cria segunda cobrança no PSP.
- Duas respostas não entendidas encerram o fluxo e o agente geral responde no mesmo turno;
  "cancelar" encerra com mensagem.
- Webhook com token errado → 401 sem efeito; mesmo evento duas vezes → um processamento;
  estorno reverte a baixa.
- `comprar_cota` → texto próprio + escalada `interesse_compra`.
- Sem `ASAAS_API_KEY` tudo funciona com o PSP simulado; com ele, o boot loga o ambiente.
- `pnpm lint && pnpm test && pnpm build` verdes.
