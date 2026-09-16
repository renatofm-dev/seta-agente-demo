# 040 — 2ª via de boleto em PDF pelo WhatsApp

> **Pré-spec** (rascunho de 14/09/2026): ainda não executada. Sexta fatia da frente
> **demo ponta a ponta**. Depende da **036** e de uma fatia fina da
> [033](033-midia-no-whatsapp.md) — **só o envio de documento**, nada de inbound, transcrição ou
> OCR. Tamanho **M**.

## Objetivo
`PainelDoCliente/SegundaViaBoleto/{idContaFinanceira}` devolve o boleto em PDF. Hoje o agente só
manda texto: `packages/wa-meta/src/gateway.ts:22` expõe `send({to, body})` e `sendTemplate`, e a
tabela `outbox` (`apps/server/src/db/schema.ts:73`) só tem `texto`. O cotista que pede "manda o
boleto" recebe, no máximo, um link.

Esta spec entrega o arquivo. É a menor fatia possível da 033 — o que a demo precisa, sem abrir a
frente inteira de mídia.

## Reaproveita
- `packages/wa-meta/src/gateway.ts` — `OutboundGateway`, `exigirJanelaAberta`, `JanelaFechadaError`,
  `createMetaGateway`; e `template.ts` (013) para o caso da janela fechada.
- `apps/server/src/wa/outbox.ts` — `enqueueOutbound` com chave idempotente, worker com retry do
  pg-boss, sweeper de órfãs. O documento entra pelo **mesmo** caminho.
- `packages/erp-api-tse` (036) — ganha `obterSegundaVia(contaFinanceiraId)` devolvendo bytes + mime.
- `apps/tse-sim` (035) — a rota da 2ª via. **Atenção, decisão tomada na 035:** o PDF do fornecedor
  **não está no repo**. São 118 KB de um boleto real, com cedente, CPF e código de barras de gente
  de verdade, e nenhuma regra de sanitização alcança bytes de PDF; a fixture guarda `contentType`,
  `bodyBytes` e o `sha256` como prova de procedência. Esta spec passa a incluir **gerar um boleto
  sintético de uma página no simulador** — o que ela precisa do fornecedor é a FORMA (é PDF, vem com
  `application/pdf`), não o documento.
- `apps/server/src/pagamentos/candidatos.ts` — já sabe quais parcelas existem e quais têm boleto.

## Escopo
- `OutboundGateway.sendDocument({to, link|id, filename, caption}, janela)` + implementação na
  Cloud API (upload de mídia ou link público — decisão abaixo).
- `outbox` ganha `anexo_url` e `anexo_nome` (migração pequena); worker envia documento quando
  presentes, texto quando não.
- `ErpApi.obterSegundaVia` + armazenamento temporário do PDF com URL assinada de vida curta (o
  WhatsApp precisa baixar).
- `ToolSpec` de leitura que **não manda o PDF** — só sinaliza a intenção; o envio é efeito do
  server, como `iniciar_pagamento`.
- Console: a mensagem com anexo aparece no painel da conversa com o nome do arquivo.

## Fora de escopo
- Tudo o resto da 033: inbound de mídia, transcrição de áudio, imagem, OCR de comprovante,
  retenção por política (024).
- Boleto do Asaas — a cobrança já devolve `urlBoleto` e o link em texto continua valendo.

## Premissas
- PDF de boleto é **dado pessoal** (nome, valor, contrato): armazenamento temporário, URL de vida
  curta, e a retenção definitiva fica com a 024.
- Fora da janela de 24h, documento exige template aprovado — o cotista que pede a 2ª via está
  dentro da janela por definição (ele acabou de escrever).
- O PDF **não** passa pela LLM em nenhum momento.

## Critérios de aceite
- "me manda a segunda via da parcela de março" → o agente identifica a parcela pelo ERP, busca o
  PDF e o arquivo chega no WhatsApp com nome legível.
- Parcela sem boleto (PIX, cartão recorrente) ⇒ o agente explica, não inventa.
- Falha ao buscar o PDF ⇒ mensagem honesta + escalada, nunca silêncio.
- Reenvio não duplica (chave idempotente do outbox).
- O PDF não aparece em log nem em prompt.
- `pnpm lint && pnpm test && pnpm build` verdes.

## O que dá para demonstrar ao final
"Me manda a segunda via" — e o boleto chega em PDF no WhatsApp.

## Decisões a resolver (registrar a escolha na descrição do PR)
- Upload de mídia na Cloud API (`media_id`) ou link público assinado. O link é mais simples; o
  upload não expõe URL.
- Onde o PDF fica: volume da instalação (021) ou objeto no provedor do cliente.
- Vida da URL assinada.
