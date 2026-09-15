# 043 — template de pagamento com PIX: link no corpo, order_details no botão

> **Executada em 15/09/2026** — PR #21. Segunda etapa da
> [frente de pagamentos](../docs/roadmap-pagamentos-whatsapp.md), sobre a
> [042](042-asaas-sandbox-real.md). O passo 1 foi concluído e **mudou o escopo**: o template
> aprovado usa `ORDER_DETAILS` (WhatsApp Pay BR), não um botão de copiar código.

## Objetivo
Existe um template de cobrança aprovado na WABA: card com o valor, o **link de pagamento**
como variável no corpo e um botão **"Copy Pix code"**. O código não consegue mandá-lo.
`payloadDeTemplate` (`packages/wa-meta/src/template.ts:176-196`) monta um único
`components:[{type:'body', parameters:[{type:'text'}]}]` — sem header, sem botão, sem
parâmetro que não seja texto posicional. Esta spec faz o `wa-meta` falar o formato do
template que o cliente já tem, e liga os dois campos que o Asaas devolve de graça.

## Passo 1 — o contrato descoberto (15/09/2026)

WABA `1041952032160944`. O template `modelo_msg_pagamento_` (id `1497672775505886`, pt_BR,
APPROVED, `parameter_format: POSITIONAL`):

```json
{"components":[
 {"type":"BODY",
  "text":"Segue o os dados para realizar o pagamento\nLink de pagamento: {{1}}\nPara mais informacoes, entre em contato com o suporte pelo numero (61) - 99999-9999",
  "example":{"body_text":[["https://gatewaydepagamento.com.br/pag"]]}},
 {"type":"BUTTONS","buttons":[{"type":"ORDER_DETAILS","text":"Copy Pix code"}]}]}
```

É a **segunda leitura**: `ORDER_DETAILS`, o fluxo de pagamentos do Brasil. O envio continua
sendo `type: template` (o gateway não muda), mas o botão carrega um pedido inteiro:

```json
{"type":"button","sub_type":"order_details","index":0,
 "parameters":[{"type":"action","action":{"order_details":{
   "reference_id":"<único>","type":"digital-goods","payment_type":"br",
   "payment_settings":[{"type":"pix_dynamic_code","pix_dynamic_code":{
      "code":"<copia-e-cola>","merchant_name":"...","key":"...","key_type":"EVP"}}],
   "currency":"BRL","total_amount":{"value":114100,"offset":100},
   "order":{"status":"pending","tax":{"value":0,"offset":100},
     "items":[{"retailer_id":"138","name":"Parcela 7/100","amount":{"value":114100,"offset":100},"quantity":1}],
     "subtotal":{"value":114100,"offset":100}}}}}]}
```

**O caminho "botão de copiar código" é impossível, não indesejado**: `COPY_CODE` aceita no
máximo **20 caracteres** e o copia-e-cola do Asaas tem **180**.

Outros fatos que o JSON revelou: o corpo tem **uma** variável (o link) — o valor vai no
`total_amount`, não no corpo, ao contrário do que o roadmap descrevia; a categoria é
**MARKETING**, não `utility`; e o template é de teste (telefone fixo `(61) - 99999-9999`,
typo *"Segue o os dados"*). É o único `ORDER_DETAILS` entre os 36 templates da WABA.

### A sonda de elegibilidade

A doc da Meta não documenta elegibilidade de WhatsApp Pay BR, disponibilidade em número de
teste, nem os valores de `key_type`. Resolvido empiricamente, mandando mensagem de verdade:

| Pergunta | Resposta |
|---|---|
| Template sem o parâmetro do botão passa? | **não** — `#131008 'action' cannot be null for ORDER_DETAILS button type`. Não existe caminho "ignorar o botão" |
| Elegibilidade bloqueia? | **não** — WABA verificada e `account_review_status: APPROVED` bastaram |
| `key_type` aceito | **EVP e CNPJ**, os dois |
| A `key` precisa estar dentro do `code`? | **não** — o EMV do Asaas é dinâmico (campo 26 é URL) e ainda assim o recebedor exibido é o certo |
| `reference_id` repetido é recusado? | **não** — aceito. O montador usa `cobranca.id` puro |
| `offset: 100` | correto: 114100 apareceu como **R$ 1.141,00** no aparelho |

No aparelho: a mensagem chega, o botão **Copy Pix code** aparece, e tocá-lo abre o fluxo de
pagamento com o valor e o recebedor corretos.

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

### `wa-meta` aprende o botão `order_details`
- `OutboundTemplate` ganha `botao?`, uma união discriminada por `tipo` com um membro hoje.
  Modelar só o que existe: um `componentes` genérico ou não valida nada, ou vira o espelho
  da gramática inteira da Meta — e header de mídia é escopo declarado da
  [033](033-midia-no-whatsapp.md).
- Dinheiro trafega em **centavos** em todo o domínio; o `{value, offset:100}` da Meta é
  escrito num lugar só, no builder. É a defesa estrutural contra o erro de 100×.
- `payloadDeTemplate` monta a lista de componentes e só a inclui se não estiver vazia —
  sem variáveis e sem botão o payload é byte a byte o de hoje, que é do que os templates
  só-corpo da [013](013-disparos-carteira.md) dependem.
- `createLogGateway` loga o botão, para o modo log não divergir do real. O `code` do PIX
  fica fora do log: é instrumento de pagamento.

### O dado da cobrança alimenta o template
- `configs/demo/client.yaml` ganha `pagamentos.pix` (`merchantName`, `key`, `keyType`) — o
  recebedor que o cotista vê na tela de pagamento. Mora no YAML por instalação, não no
  `.env`: é identidade do cliente, não segredo, e a [023](023-waba-do-cliente.md) o torna
  por-cliente trocando de arquivo, sem código.
- `WA_TEMPLATE_COBRANCA_PIX` no `.env` liga a feature. Ausente ⇒ comportamento da 014,
  intocado.
- Um montador puro em `apps/server/src/pagamentos/order-details.ts` traduz a cobrança no
  pedido: `reference_id` ← `cobranca.id`; `code` ← `pixCopiaCola`; um item por título.
  Devolve `null` para boleto e cartão (não são pagáveis dentro do WhatsApp) e quando falta
  recebedor ou copia-e-cola — nunca lança, pelo mesmo princípio de `notificarPago`.
- Soma dos títulos divergente do total (juros/multa) **colapsa num item só**: a Meta recusa
  soma que não fecha, com erro opaco.

### Quem decide texto × template
`outbox` ganha uma coluna `template jsonb`, e o worker usa o template **no ramo
`JanelaFechadaError` que hoje só desiste** (`outbox.ts:169-179`: marca `janela_fechada` e
escala ticket).

A decisão não pode ser tomada na emissão: a janela pode fechar entre o INSERT e o envio,
porque o backoff do pg-boss atravessa a fronteira. Só o worker, no instante do
`gateway.send`, sabe. Isso também herda de graça o dedupe, o retry, o sweeper e a semântica
de ticket, e conserta o caso geral — hoje **qualquer** mensagem do bot fora da janela vira
ticket.

O template vai **só na linha 1** do outbox. As linhas 2+ são o copia-e-cola cru, que já
viaja dentro do `order_details`; anexar nelas abriria uma segunda conversa de template,
cobrada, dizendo a mesma coisa.

### Confirmação de pagamento fora da janela
- `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` preenchido e documentado.
- Teste cobrindo os dois ramos de `notificarPago`: janela aberta manda texto livre pelo
  outbox; janela fechada manda template. Hoje **nenhum teste toca esse caminho**, e sem a
  variável o cotista não é avisado em silêncio. O fake de gateway de
  `cobranca.integration.test.ts` passa a registrar as chamadas — sem isso não há o que
  asserir.

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
- Cadastrar template com botão pela plataforma (`TemplateDefSchema`/`criar`): a Meta revisa
  fluxo de pagamento, e o template do cliente nasce no WhatsApp Manager — [023](023-waba-do-cliente.md).
- Trazer os `components` do template remoto para o espelho local (`listar` sem `components`,
  `sincronizar` só status): o console continua sem o corpo real dos templates criados fora.
- Pagamento com dinheiro de verdade — [027](027-asaas-producao.md), decisão D1.

## Premissas
- O template da sonda é **MARKETING** e é de teste — telefone fixo e typo no corpo. O
  definitivo, na categoria certa, é da [023](023-waba-do-cliente.md); o custo por conversa e
  as regras de opt-in são a decisão **D7**.
- O número de teste da Meta bastou para validar (WABA verificada, até 5 destinatários).
- A chave PIX do `client.yaml` precisa ser a da conta que emite a cobrança no PSP — é o que
  o cotista vê como recebedor.

## Plano B (não foi necessário)
Se a sonda tivesse reprovado por elegibilidade, o caminho seria um template `utility` novo
com o valor e o copia-e-cola como variáveis de corpo (180 chars cabem no limite de 1024) e um
botão `URL` para a `invoiceUrl`. A união discriminada do `botao` foi desenhada para aceitar
esse membro sem refatoração — registrado aqui caso a Meta mude de política.

## Critérios de aceite
1. O JSON do template aprovado está transcrito na spec, e o builder monta exatamente aquele
   payload — provado por teste com o fake de `fetch`.
2. Um template só-corpo da 013 gera o mesmo payload de antes desta spec — **comparação de
   string do JSON serializado**, não de objeto: é o que prova "byte a byte".
3. Uma cobrança emitida na 042 vira mensagem de template com o link do Asaas no corpo e o
   `order_details` no botão; no aparelho, tocar o botão abre o fluxo de pagamento com valor e
   recebedor corretos. (O PIX do sandbox **não é pagável** por app de banco real — a baixa
   continua vindo pelo caminho de webhook da 042.)
4. Com a janela de 24 h fechada, a confirmação de pagamento chega por template; com a janela
   aberta, chega como texto livre. Ambos com teste.
5. Sem `WA_TEMPLATE_PAGAMENTO_CONFIRMADO`, o comportamento continua sendo o log de hoje —
   nada quebra.
6. `pnpm lint && pnpm test && pnpm build` verdes.
