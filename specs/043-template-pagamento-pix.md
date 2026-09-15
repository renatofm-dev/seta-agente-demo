# 043 — template de pagamento com PIX: link no corpo, código no botão

> **Pré-spec** (rascunho de 15/09/2026): segunda etapa da
> [frente de pagamentos](../docs/roadmap-pagamentos-whatsapp.md). Depende da
> [042](042-asaas-sandbox-real.md) (precisa de link e PIX de verdade) e de `WA_WABA_ID` no
> `.env`. **O escopo abaixo é provisório até o passo 1** — ver "Premissas".

## Objetivo
Existe um template de cobrança aprovado na WABA: card com o valor, o **link de pagamento**
como variável no corpo e um botão **"Copy Pix code"**. O código não consegue mandá-lo.
`payloadDeTemplate` (`packages/wa-meta/src/template.ts:176-196`) monta um único
`components:[{type:'body', parameters:[{type:'text'}]}]` — sem header, sem botão, sem
parâmetro que não seja texto posicional. Esta spec faz o `wa-meta` falar o formato do
template que o cliente já tem, e liga os dois campos que o Asaas devolve de graça.

## Passo 1 — descobrir o contrato (antes de escrever código)
Com `WA_WABA_ID` e `WA_ACCESS_TOKEN` preenchidos,
`GET /{WABA_ID}/message_templates?name=<nome>` devolve o JSON de componentes do template
aprovado. **Esse JSON é a especificação desta spec**; o preview do WhatsApp Manager não é
prova do formato do payload de envio.

Duas leituras possíveis, com tamanhos diferentes — a spec registra qual é antes de começar:

- **template comum com botão de copiar código**: o envio continua sendo `type: template` e o
  trabalho é acrescentar componentes ao builder. É o escopo escrito abaixo.
- **mensagem de _order details_ da Meta** (fluxo de pagamentos do Brasil): não é
  `type: template`, carrega `payment_settings` e tem ciclo de status próprio. Nesse caso o
  escopo abaixo é substituído e a estimativa refeita antes de abrir o editor.

## Reaproveita
- `packages/wa-meta/src/template.ts`: `payloadDeTemplate` (`:176-196`), `TemplateDefSchema`
  (`:30-54`), `variaveisDoCorpo` (`:25-28`), `createMetaTemplateApi` (`:89-162`).
- `packages/wa-meta/src/gateway.ts:79-83` — `sendTemplate` já dispensa a janela de 24 h por
  desenho.
- `apps/server/src/pagamentos/eventos.ts:216-247` — o gancho de "pagamento confirmado" com
  fallback para template já está escrito; falta a variável e o formato.
- Do Asaas, sem chamada nova: `invoiceUrl` vem de `criarCobranca`
  (`packages/payment-provider/src/asaas.ts:94`) e o copia-e-cola de `obterPix` (`:199-204`).
- `apps/server/src/disparos-routes.ts:74-132` (cadastrar e sincronizar modelo) e
  `packages/wa-meta/test/template.test.ts:11-18` (o fake de `fetch`).

## Escopo

### `wa-meta` aprende os componentes que faltam
- `payloadDeTemplate` passa a montar, além do corpo, os componentes que o template usa —
  header e botão — mantendo **compatibilidade total** com os templates só-corpo que a
  [013](013-disparos-carteira.md) registra: sem os campos novos, o payload gerado é
  byte a byte o de hoje.
- `TemplateDefSchema` aceita declarar esses componentes no cadastro, com a mesma validação
  de variáveis sequenciais que já existe.
- Tipos exportados em `index.ts` acompanham.

### O dado da cobrança alimenta o template
- Um montador em `apps/server/src/pagamentos/` traduz uma `cobranca` emitida nas variáveis
  do template: link do corpo ← `invoiceUrl`; código do botão ← PIX copia-e-cola; valor
  formatado em reais pelo helper que já existe.
- A cobrança guarda o que foi enviado, para o console mostrar o que o cotista viu — hoje
  `eventos.ts:236-244` grava um texto local que pode divergir do corpo do template.

### Confirmação de pagamento fora da janela
- `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` preenchido e documentado.
- Teste cobrindo os dois ramos de `eventos.ts:216-235`: janela aberta manda texto livre pelo
  outbox; janela fechada manda template. Hoje **nenhum teste toca esse caminho**, e sem a
  variável o cotista não é avisado em silêncio (`eventos.ts:226-229`).

### Documentação
`docs/meta-setup.md` ganha o que falta: como obter o `WA_WABA_ID`, categoria utility ×
marketing, o ciclo de aprovação e o que fazer quando a Meta recategoriza.

## Fora de escopo
- Header de mídia (imagem, vídeo, documento) — [033](033-midia-no-whatsapp.md).
- Webhook `message_template_status_update`: o sync continua sendo o botão manual —
  [023](023-waba-do-cliente.md).
- Variável por destinatário e disparo em lote — [044](044-cobranca-proativa.md).
- Número comercial do cliente e templates definitivos — [023](023-waba-do-cliente.md).
- Qualquer mudança no adapter do Asaas — [042](042-asaas-sandbox-real.md).

## Premissas
- **O escopo depende do passo 1.** Se o template for _order details_, esta spec é reescrita
  antes da implementação; o que não muda é o objetivo (mandar o template que o cliente já
  tem aprovado, com link e PIX vindos do Asaas).
- O template está aprovado na categoria **utility**; se a Meta recategorizar, o envio segue
  funcionando e o custo muda — decisão D7.
- O número de teste da Meta basta para validar (até 5 destinatários verificados).

## Critérios de aceite
1. O JSON do template aprovado está transcrito na spec, e o builder monta exatamente aquele
   payload — provado por teste com o fake de `fetch`.
2. Um template só-corpo da 013 gera o mesmo payload de antes desta spec (teste de
   regressão).
3. Uma cobrança emitida na 042 vira mensagem de template com o link do Asaas no corpo e o
   PIX copia-e-cola no botão; copiar o código no celular e pagar confirma a cobrança.
4. Com a janela de 24 h fechada, a confirmação de pagamento chega por template; com a janela
   aberta, chega como texto livre. Ambos com teste.
5. Sem `WA_TEMPLATE_PAGAMENTO_CONFIRMADO`, o comportamento continua sendo o log de hoje —
   nada quebra.
6. `pnpm lint && pnpm test && pnpm build` verdes.
