# Templates do WhatsApp — catálogo para cadastrar na API oficial

Todos os modelos do fluxo de cobrança, prontos para submeter à Meta, com o payload exato de
criação e o que cada um exige do código. Escrito em 15/09/2026, durante a
[043](../specs/043-template-pagamento-pix.md).

> **Os seis já estão cadastrados** na WABA `1137251935512196` (número +55 61 94758-1802),
> criados por esta API em 15/09/2026 e aguardando revisão da Meta. O que está abaixo é o que
> foi submetido e por quê — use para recriar em outra WABA ou para entender as variáveis.
>
> **Leia o §5 antes de ligar cada um.** Três dependem de código que ainda não existe —
> apontar o `.env` para eles produz mensagem que a Meta recusa no envio.

## 1. Antes de começar

```sh
# do .env
WABA=$WA_WABA_ID          # 1137251935512196 (número +55 61 94758-1802)
TOKEN=$WA_ACCESS_TOKEN
BASE=https://graph.facebook.com/v21.0/$WABA/message_templates
```

**O console não serve para estes.** `POST /api/console/modelos` monta só `BODY` + `FOOTER`
(`packages/wa-meta/src/template.ts:99-132`); nenhum destes templates tem só isso. Use os
`curl` abaixo ou o WhatsApp Manager. Ensinar a plataforma a cadastrar botão é escopo da
[023](../specs/023-waba-do-cliente.md).

### Limites que a Meta impõe (verificados na doc, não de memória)

| Componente | Limite |
|---|---|
| `BODY` | 1024 caracteres |
| `HEADER` texto | 60 caracteres, **1** variável |
| `FOOTER` | 60 caracteres, sem variável |
| Botões, total | 10 |
| `QUICK_REPLY` | até 10 — e **agrupados**, nunca intercalados com outros tipos |
| `URL` | até 2 |
| `PHONE_NUMBER` | 1 |
| Rótulo do botão | 25 caracteres |
| URL do botão | 2000 caracteres; variável **só no fim** (`.../{{1}}`) |
| `COPY_CODE` | **20 caracteres** — não cabe PIX (180) nem linha digitável (47) |

### Cinco armadilhas — as duas últimas custaram reprovação de verdade

1. **A categoria não muda depois de aprovada.** Submeta como `UTILITY`: é mais barata e não
   exige opt-in. A Meta recategoriza o que julgar promocional — evite saudação, emoji de
   festa e qualquer coisa que soe a oferta.
2. **A URL base do botão fica congelada no template.** Um botão apontando para
   `sandbox.asaas.com` **não funciona em produção**, e trocar exige template novo. Por isso
   os modelos abaixo põem o link **no corpo**, não em botão de URL — a variável de corpo
   aceita a URL inteira e atravessa a troca de ambiente sem cadastro novo.
3. **Uma WABA com pendência de pagamento não deixa criar template novo.** Sintoma é
   `#100/2388339`, que não fala em pagamento nenhum — ver §3.
4. **Variável não pode abrir nem fechar o corpo.** `#100/2388299`: *"As variáveis não podem
   estar no início ou no fim do modelo"*. O `cobranca_boleto` foi recusado por terminar em
   `{{4}}`; passou ao ganhar texto depois do link.
5. **O rótulo do botão `ORDER_DETAILS` é fixo pela Meta.** `#100/2388153`: *"O texto do tipo
   de botão ORDER_DETAILS não pode ser modificado e sempre deve ser 'Copy Pix code'"*. Tentei
   "Copiar código PIX" e foi recusado — é por isso que o template antigo estava em inglês.
   Não é escolha de quem cadastrou, e não há como traduzir.

---

## 2. Os templates

### 2.1 `cobranca_pix` — cobrança com PIX (substitui o `modelo_msg_pagamento_`)

O que existe hoje na WABA é `modelo_msg_pagamento_`: **MARKETING**, com telefone de suporte
fixo `(61) - 99999-9999`, typo *"Segue o os dados"* e exemplo `gatewaydepagamento.com.br`. Foi
o que a 043 usou para validar, e serve para demo — **não para o piloto**.

O botão `ORDER_DETAILS` é o fluxo de pagamentos do Brasil: o copia-e-cola não vai como texto,
vai dentro do pedido que o servidor monta no envio. Na criação, o botão é só tipo + rótulo.

```sh
curl -sS -X POST "$BASE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "cobranca_pix",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "Sua cobrança de {{1}} está pronta.\nVence em {{2}}.\nPague pelo link {{3}} ou toque no botão abaixo para copiar o código PIX.",
      "example": { "body_text": [["R$ 1.141,00", "18/09/2026", "https://www.asaas.com/i/abc123"]] } },
    { "type": "FOOTER", "text": "Mirante da Serra Resort" },
    { "type": "BUTTONS", "buttons": [ { "type": "ORDER_DETAILS", "text": "Copy Pix code" } ] }
  ]
}'
```

| Variável | Vem de |
|---|---|
| `{{1}}` valor | `formatarReais(cobranca.valorCentavos)` |
| `{{2}}` vencimento | `formatarData(cobranca.vencimentoPsp)` |
| `{{3}}` link | `cobranca.urlFatura` (a `invoiceUrl` do Asaas) |

**Código:** pronto. `montarBotaoPix` (`apps/server/src/pagamentos/order-details.ts`) monta o
pedido, `payloadDeTemplate` o serializa e `emitir.ts` manda as três variáveis na ordem do
corpo. `WA_TEMPLATE_COBRANCA_PIX=cobranca_pix` já está no `.env`. **Mudar o corpo na Meta
exige mudar a lista de variáveis junto** — a Meta recusa aridade diferente no envio.

### 2.2 `cobranca_boleto` — boleto com linha digitável

A linha digitável tem 47 dígitos: não cabe em `COPY_CODE` (20). Vai no corpo, que o WhatsApp
deixa selecionar e copiar com toque longo.

```sh
curl -sS -X POST "$BASE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "cobranca_boleto",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "Seu boleto de {{1}} está pronto, com vencimento em {{2}}.\nLinha digitável para copiar no app do banco:\n{{3}}\nSe preferir o PDF, use o link {{4}} — qualquer dúvida, é só responder por aqui.",
      "example": { "body_text": [["R$ 1.141,00", "18/09/2026", "23793.38128 60082.117208 18000.063305 8 11410000114100", "https://www.asaas.com/b/pdf/abc123"]] } },
    { "type": "FOOTER", "text": "Mirante da Serra Resort" }
  ]
}'
```

| Variável | Vem de |
|---|---|
| `{{1}}` valor / `{{2}}` vencimento | como acima |
| `{{3}}` linha digitável | `cobranca.linhaDigitavel` (gravada na emissão) |
| `{{4}}` PDF | `cobranca.urlBoleto ?? cobranca.urlFatura` |

**Código:** falta ligar. Todos os dados já estão na linha da cobrança desde a
[042](../specs/042-asaas-sandbox-real.md); o que falta é `emitir.ts` anexar este template à
linha do outbox quando `metodo === 'boleto'` — hoje `montarBotaoPix` devolve `null` para
boleto e a linha vai sem template, então janela fechada ainda vira ticket. É uma função irmã
do montador de PIX, sem botão.

### 2.3 `boleto_segunda_via` — reenvio de boleto já emitido

Separado do 2.2 de propósito: o texto reconhece que já houve um envio, e isso muda a leitura
do cotista. É o par natural da [040](../specs/040-segunda-via-pdf.md).

```sh
curl -sS -X POST "$BASE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "boleto_segunda_via",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "Aqui está a 2ª via do seu boleto de {{1}}, com vencimento em {{2}}.\nLinha digitável:\n{{3}}\nPDF: {{4}}\nSe já pagou, pode ignorar esta mensagem.",
      "example": { "body_text": [["R$ 1.141,00", "18/09/2026", "23793.38128 60082.117208 18000.063305 8 11410000114100", "https://www.asaas.com/b/pdf/abc123"]] } },
    { "type": "FOOTER", "text": "Mirante da Serra Resort" }
  ]
}'
```

**Código:** o fluxo já distingue reenvio — `mensagensEmitida` recebe `reenvio: boolean` e
prefixa *"Você já tinha um boleto gerado…"* (`packages/cobranca/src/render.ts:155-157`). Falta
só escolher este nome em vez do 2.2 quando `reenvio` é verdadeiro.

### 2.4 `cobranca_cartao` — link de pagamento por cartão

```sh
curl -sS -X POST "$BASE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "cobranca_cartao",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "Seu link de pagamento de {{1}} está pronto.\nPague com cartão em: {{2}}\nO pagamento é feito em página segura — nunca pedimos dados do cartão por aqui.",
      "example": { "body_text": [["R$ 1.141,00", "https://www.asaas.com/i/abc123"]] } },
    { "type": "FOOTER", "text": "Mirante da Serra Resort" }
  ]
}'
```

A última frase não é enfeite: ela está no texto do produto
(`packages/cobranca/src/render.ts:181-182`) porque é a defesa contra alguém se passando pelo
resort para pedir cartão.

### 2.5 `pagamento_confirmado` — baixa confirmada fora da janela

**Este é o único que a 043 já consome e que ainda não existe na WABA.** Sem ele, todo
pagamento confirmado fora da janela de 24 h só vira linha de log — o cotista não é avisado.

```sh
curl -sS -X POST "$BASE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "pagamento_confirmado",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "Pagamento confirmado! Recebemos {{1}} e a baixa já consta no seu contrato. Obrigado!",
      "example": { "body_text": [["R$ 1.141,00"]] } },
    { "type": "FOOTER", "text": "Mirante da Serra Resort" }
  ]
}'
```

**Código:** pronto e testado (`cobranca.integration.test.ts`, casos `043:`). Depois de
aprovado, `WA_TEMPLATE_PAGAMENTO_CONFIRMADO=pagamento_confirmado` no `.env` e acabou. Uma
variável só, na ordem que `notificarPago` já manda.

### 2.6 `escolha_metodo` — como o cotista quer pagar

**Este precisa de código antes de ser útil — veja o §5.** Com botões, a resposta chega como
`type: "button"`, e o parser de entrada descarta tudo que não é texto.

```sh
curl -sS -X POST "$BASE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "escolha_metodo",
  "language": "pt_BR",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "Sobre as parcelas de {{1}} do seu contrato: como você prefere pagar?",
      "example": { "body_text": [["R$ 1.141,00"]] } },
    { "type": "BUTTONS", "buttons": [
      { "type": "QUICK_REPLY", "text": "PIX" },
      { "type": "QUICK_REPLY", "text": "Boleto" },
      { "type": "QUICK_REPLY", "text": "Cartão" }
    ] }
  ]
}'
```

**Alternativa que funciona hoje, sem código novo:** o mesmo corpo sem botões, pedindo resposta
por número — é exatamente o que `TEXTO_METODO` faz dentro da janela. Perde o toque único, não
perde o fluxo.

```json
{ "type": "BODY",
  "text": "Sobre as parcelas de {{1}} do seu contrato: como você prefere pagar?\nResponda 1 para PIX, 2 para boleto ou 3 para cartão.",
  "example": { "body_text": [["R$ 1.141,00"]] } }
```

---

## 3. Estado atual (15/09/2026)

| Template | Id na Meta | Status |
|---|---|---|
| `pagamento_confirmado` | 921040130681182 | PENDING |
| `cobranca_pix` | 1573917787768524 | PENDING |
| `cobranca_boleto` | 2174610059790508 | PENDING |
| `boleto_segunda_via` | 28278012451840938 | PENDING |
| `cobranca_cartao` | 1091345723376436 | PENDING |
| `escolha_metodo` | 1094150733126875 | PENDING |

### Por que não deu para criar na WABA antiga

A WABA `1041952032160944` (número +55 61 94758-1339) recusa **criar template novo** com
`#100/2388339 "WhatsApp accounts cannot be used with this API"` — em qualquer versão da Graph
API, qualquer categoria, idioma ou encoding. Não é permissão: POST com nome já existente é
processado (devolve erro semântico de categoria), `DELETE` no mesmo edge funciona e
`POST /subscribed_apps` funciona. O que a WABA tem é isto:

```json
"health_status": { "can_send_message": "BLOCKED",
  "errors": [{ "error_code": 141006,
    "error_description": "There is an error with the payment method.
                          This will block business initiated conversations." }] }
```

Método de pagamento com erro. **Isso também trava a [044](../specs/044-cobranca-proativa.md)**,
que é toda business-initiated. A WABA nova nasceu com `can_send_message: AVAILABLE` em todos
os níveis, e a criação passou de primeira.

## 4. Depois de submeter

A aprovação é assíncrona. Para acompanhar:

```sh
curl -sS "$BASE?fields=name,status,category,rejected_reason&limit=100" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

No console, **Configurações › Modelos › sincronizar** traz o status para o espelho local — mas
só o status: corpo e componentes de templates criados fora da plataforma não entram
(`disparos-routes.ts:103-132`). Se a Meta devolver `category: MARKETING` no que você submeteu
como `UTILITY`, ela recategorizou: o envio continua funcionando, o custo e as regras de opt-in
é que mudam (decisão **D7**).

## 5. O que cada um exige do código

| Template | Estado | O que falta |
|---|---|---|
| `pagamento_confirmado` | ✅ ligado | — |
| `cobranca_pix` | ✅ ligado | — |
| `cobranca_boleto` | ✅ ligado | — |
| `cobranca_cartao` | ✅ ligado | — |
| `boleto_segunda_via` | ⚠️ montador pronto, **sem gatilho** | ver abaixo |
| `escolha_metodo` **com botões** | ❌ **não funciona** | ver abaixo |

Os quatro ligados saem de `montarTemplateCobranca`
(`apps/server/src/pagamentos/template-cobranca.ts`), que escolhe o modelo pelo método e monta
as variáveis na ordem do corpo aprovado. Os nomes vêm do `.env`
(`WA_TEMPLATE_COBRANCA_PIX`, `_BOLETO`, `_CARTAO`, `WA_TEMPLATE_BOLETO_SEGUNDA_VIA`); modelo
ausente ⇒ aquele método não manda template e a janela fechada volta a virar ticket.

### Por que a 2ª via não tem gatilho

O montador escolhe `boleto_segunda_via` quando `DadosEmissao.reenvio` é verdadeiro, e isso
está testado — mas **ninguém passa `true` num caminho de janela fechada**. A emissão
(`emitir.ts`) é sempre primeira entrega do ponto de vista do cotista: `reaproveita` só diz que
o PSP já tinha a cobrança (retry de job), não que o cotista já a recebeu. O reenvio de verdade
mora em `fluxo.ts:383-396`, e lá a janela está aberta por definição — o cotista acabou de
escrever.

O gatilho nasce quando existir reenvio **fora** da janela: a [040](../specs/040-segunda-via-pdf.md)
(pedir 2ª via) ou a [044](../specs/044-cobranca-proativa.md) (a plataforma abre a conversa).

### A trava do `escolha_metodo`

`packages/wa-meta/src/payload.ts:57` faz `if (msg.type !== 'text' || !msg.text) continue;`.
Resposta de `QUICK_REPLY` chega como `type: "button"`, com `button.text` e `button.payload` —
e é **descartada em silêncio**: sem erro, sem log, sem ticket. O cotista tocaria no botão e
nada aconteceria.

Ligar é pequeno — o parser passa a aceitar `button` e mapear `button.text` para o texto do
turno, e o fluxo existente reconhece "PIX"/"Boleto"/"Cartão" como já reconhece "1"/"2"/"3".
Mas é código, e não está em nenhuma spec ainda. **Recomendo cadastrar a variante sem botões
(§2.6) e abrir isso como item da [044](../specs/044-cobranca-proativa.md)**, que é quando a
plataforma passa a abrir conversa e o botão realmente paga a pena.

## 6. Ordem sugerida

1. **`pagamento_confirmado`** — hoje. É o único que destrava comportamento já implementado e
   testado, e a aprovação leva tempo.
2. **`cobranca_pix`** como `UTILITY` — substitui o template de teste e tira o telefone errado
   da frente do cotista.
3. **`cobranca_boleto`** e **`boleto_segunda_via`** — quando o montador irmão existir.
4. **`escolha_metodo`** sem botões, se quiser cobrir a escolha fora da janela.
5. `cobranca_cartao` por último: é o método menos usado na carteira inadimplente.
