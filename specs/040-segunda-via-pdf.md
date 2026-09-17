# 040 — 2ª via de boleto em PDF pelo WhatsApp

> **Entregue em 17/09/2026.** O que saiu está em
> [`docs/dev/04-modulos-entregues.md`](../docs/dev/04-modulos-entregues.md).
>
> Sétima fatia da frente **demo ponta a ponta**, e a última que faltava para a demo. Depende da
> **036** e de uma fatia fina da [033](033-midia-no-whatsapp.md) — **só o envio de documento**,
> nada de inbound, transcrição ou OCR. Tamanho **M**.
>
> **As três decisões que a pré-spec deixou em aberto foram resolvidas, e resolvê-las cancelou
> duas delas** — ver [Decisões resolvidas](#decisões-resolvidas) no fim.

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

## Decisões resolvidas

A pré-spec deixou três perguntas. A primeira foi respondida **upload**, e a resposta apagou as
outras duas.

**1. Upload de mídia (`media_id`), não link público assinado.** O boleto traz nome, CPF e valor —
um link assinado é um endereço público para dado pessoal, ainda que de vida curta, e a regra da
casa é não pôr dado pessoal em URL. Com upload, o arquivo sobe para a Meta em `/media`, vira id, e
**nenhuma URL nossa serve esse conteúdo em momento nenhum**.

**2. Onde o PDF fica: em lugar nenhum.** Esta é a consequência que vale a spec. Sem URL para servir,
não há o que armazenar: os bytes existem só entre a resposta do ERP e o `POST /media`, dentro do
job. Não há volume, não há coluna, não há objeto no provedor — e a retenção que a **024** vai
precisar definir não ganhou mais um item hoje.

**3. Vida da URL assinada: não se aplica.** Não há URL.

### Divergência em relação ao desenho da pré-spec

A pré-spec pedia `outbox.anexo_url` e `outbox.anexo_nome`. Com upload não existe URL para guardar,
e guardar os **bytes** numa coluna seria o pior dos dois mundos: o PDF passaria a viver no backup do
Postgres para sempre.

O que a coluna guarda é um **descritor** — `{tipo, contaFinanceiraId, filename}` em `outbox.anexo` —
e o worker resolve no instante do envio. Três consequências, todas boas:

- o retry do pg-boss continua valendo: cada tentativa busca o arquivo de novo, em vez de reenviar um
  `media_id` que a Meta já pode ter expirado (eles valem 30 dias);
- o descritor não guarda nada que a linha ao lado já não guarde;
- `mensagem.anexo_nome` (o que o console lê) é só o NOME — o console registra que um boleto foi
  entregue e qual, sem nunca servir o arquivo.

### Divergência no dublê: 404 sem exemplo do fornecedor

A coleção só tem o caso feliz (200, `application/pdf`, 118 KB). **Erro não tem exemplo nenhum.** O
simulador escolheu 404 no envelope do ASP.NET para os três casos sem arquivo (parcela inexistente,
fora do escopo do token, e sem boleto gerado), e registrou a escolha em
`test/divergencias.integration.test.ts` — para quem for ligar no TSE real (**041**) saber que isto é
decisão nossa, não comportamento observado.

No caminho feliz o produto nunca chega no 404: a tool confere `linha_digitavel` pelo catálogo antes
de pedir o arquivo. O tratamento existe porque o ERP pode discordar do espelho — e aí a linha vira
`falha`, um humano é chamado **e o cotista recebe uma mensagem honesta**. Só o ticket não bastava:
o agente acabou de dizer "já estou te enviando", e sumir depois de prometer é pior do que nunca ter
oferecido.

### O boleto sintético

O PDF do fornecedor **não está no repo** (decisão da 035: 118 KB com cedente, CPF e código de
barras de gente real, e nenhuma regra de sanitização alcança bytes de PDF). A fixture guarda
`contentType`, `bodyBytes` e o `sha256` como prova de procedência — que é a FORMA de que esta spec
precisava.

O dublê gera o seu, escrito à mão em `apps/tse-sim/src/boleto-pdf.ts`: a stack é travada e não tem
lib de PDF, e um PDF 1.4 de uma página com fontes-padrão é pequeno o bastante para isso ser honesto.
O papel **diz que é simulado, em tarja no topo** — um boleto que parece pagável e não é seria pior
que texto nenhum.

### Para ver na demo

A 2ª via sai pelo `ErpWriter`. Sem `TSE_BASE_URL` o server usa o writer **em memória**, que não tem
documento nenhum para servir — e aí o agente responde que não conseguiu, honestamente. Para a demo,
aponte `TSE_BASE_URL=http://localhost:3010` (o simulador), como o `.env.example` registra. Desenhar
boleto é trabalho do ERP: o produto não sabe, e não deve saber, fazer isso.
