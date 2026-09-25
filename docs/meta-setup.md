# Setup do WhatsApp (Meta Cloud API) — número de teste

Passo a passo manual (≈15 min). Resultado: número de teste grátis, até 5 destinatários
verificados — suficiente para a demo (000). WABA real fica para depois da POC.

## 1. App Meta

1. <https://developers.facebook.com> → **My Apps** → **Create App** → tipo **Business**.
2. No app: **Add product** → **WhatsApp** → **Set up** (vincule/crie uma Business Account).

## 2. Número de teste + destinatários

1. Em **WhatsApp → API Setup** já vem um **test number** provisionado.
2. Anote o **Phone number ID** → `WA_PHONE_NUMBER_ID` no `.env`.
3. Em **To**, adicione até **5 números verificados** (recebem código por WhatsApp).
   Use os mesmos números do `configs/demo/contatos.yaml`.

## 3. Token e app secret

1. **API Setup → Temporary access token** (24 h; para a demo, gere um **System User
   token** permanente em Business Settings → System Users) → `WA_ACCESS_TOKEN`.
2. **App Settings → Basic → App Secret** → `WA_APP_SECRET` (valida o HMAC do webhook).

## 4. Webhook

- URL de produção (011): `https://seta.outerlab.com.br/webhook`
- Dev (1 comando): sobe o `pnpm dev` se preciso, abre um túnel Cloudflare e
  aplica o override de webhook **só no número de teste** (o webhook do app
  intacto; Ctrl+C devolve o número ao destino anterior — a VPS da demo — e
  derruba tudo):

  ```sh
  pnpm dev-whatsapp        # = tools/dev-whatsapp.sh
  ```

  Na mão, se preferir: `cloudflared tunnel --url http://localhost:3001` e use a
  URL https gerada (`<aleatorio>.trycloudflare.com/webhook`) nos passos abaixo.
  Por que o override é por número, o que o script faz em cada passo e o diagnóstico
  do túnel: [`dev/09-whatsapp-real-e-tunel.md`](dev/09-whatsapp-real-e-tunel.md).

1. **WhatsApp → Configuration → Webhook** → **Edit**:
   - Callback URL: `https://<host>/webhook`
   - Verify token: o valor de `WA_VERIFY_TOKEN` do `.env`
2. **Manage** → assinar o campo **messages**.
3. A Meta faz `GET /webhook` com `hub.challenge` — o server responde e o webhook fica verde.

## 5. Ida e volta de teste

1. `pnpm dev-whatsapp` (com `.env` preenchido) — ou `pnpm dev` + túnel na mão.
2. Envie "oi" do seu celular verificado para o número de teste.
3. Confira no log: mensagem persistida → turno agregado (4 s) → resposta via outbox
   (o conteúdo da resposta chega com o runtime da spec 005).
4. **Anexar screenshot da ida e volta no PR da 004** (critério de aceite).

## Diagnóstico rápido

| Sintoma | Causa provável |
| --- | --- |
| Webhook não verifica | `WA_VERIFY_TOKEN` diferente do digitado na Meta |
| `curl` na URL do túnel dá `Could not resolve host` (handshake público falha em série) | nome `*.trycloudflare.com` consultado antes da Cloudflare publicar o DNS; o resolver (operadora/macOS) cacheia NXDOMAIN por 30 min (SOA min = 1800 s). O `pnpm dev-whatsapp` espera o `Registered tunnel connection` e valida com `--resolve` no IP da Cloudflare; na mão, espere ~10 s antes do 1º teste ou use `dig @1.1.1.1`. A Meta não é afetada (usa o DNS dela). |
| POST /webhook → 401 | `WA_APP_SECRET` errado (HMAC não bate) |
| Mensagem não chega | campo **messages** não assinado no webhook |
| Envio falha 401/190 | token expirado (usar System User token) |
| `janela_fechada` no outbox | contato não mandou mensagem nas últimas 24 h |

## 6. Modelos de mensagem (WA_WABA_ID)

O `WA_WABA_ID` habilita a gestão de modelos (`/api/console/modelos`) e é o que permite ler o
JSON dos templates aprovados. Está em **WhatsApp → Configuração da API**, logo abaixo do
número, como *"Identificação da conta do WhatsApp Business"* (15–16 dígitos). **Não dá para
derivá-lo do token**: as bordas que levariam a ele exigem `business_management`, que o token
do app não tem.

Para ver o que existe hoje, com os componentes:

```sh
curl -s "https://graph.facebook.com/v21.0/$WA_WABA_ID/message_templates?fields=id,name,language,category,status,components&limit=100" \
  -H "Authorization: Bearer $WA_ACCESS_TOKEN"
```

**O preview do WhatsApp Manager não é prova do formato de envio** — só esse JSON é.

### utility × marketing

A categoria é decidida na aprovação e **não muda depois**. `utility` é mais barata e não
exige opt-in; `marketing` custa mais e a Meta pode limitar entrega. Submeter como utility não
garante nada: a Meta recategoriza o que julgar promocional. O status e o motivo de rejeição
chegam ao console pelo botão **sincronizar** (`POST /api/console/modelos/sincronizar`), que
hoje atualiza só o status — corpo e componentes de templates criados no WhatsApp Manager não
entram no espelho local.

## 7. Pagamentos no WhatsApp (order_details)

O template de cobrança da 043 usa um botão `ORDER_DETAILS` — o fluxo de pagamentos do Brasil.
O que a validação de 15/09/2026 mostrou, e que a doc da Meta não diz:

- **Não existe caminho "ignorar o botão"**: mandar só o corpo devolve
  `#131008 'action' cannot be null for ORDER_DETAILS button type`.
- **Elegibilidade**: WABA com `account_review_status: APPROVED` e
  `business_verification_status: verified` bastou. Não houve onboarding extra de WhatsApp Pay.
- **`key_type`**: `EVP` e `CNPJ` foram aceitos.
- **A chave não precisa estar dentro do `code`**: o copia-e-cola do Asaas é dinâmico (o campo
  26 do EMV é uma URL, e o Asaas é o recebedor de registro) e ainda assim o nome exibido ao
  cotista é o do `merchant_name` que mandamos.
- **`reference_id` repetido é aceito** — a Meta não recusa reenvio com a mesma referência.
- **`offset: 100`**: `{"value":114100,"offset":100}` aparece como R$ 1.141,00 no aparelho.

O recebedor (`merchantName`, `key`, `keyType`) fica em `configs/demo/client.yaml`, bloco
`pagamentos.pix`, e tem que ser o da conta que emite a cobrança no PSP.

