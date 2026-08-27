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
- Dev: túnel Cloudflare apontando para o server local:

  ```sh
  cloudflared tunnel --url http://localhost:3001
  # use a URL https gerada: <aleatorio>.trycloudflare.com/webhook
  ```

1. **WhatsApp → Configuration → Webhook** → **Edit**:
   - Callback URL: `https://<host>/webhook`
   - Verify token: o valor de `WA_VERIFY_TOKEN` do `.env`
2. **Manage** → assinar o campo **messages**.
3. A Meta faz `GET /webhook` com `hub.challenge` — o server responde e o webhook fica verde.

## 5. Ida e volta de teste

1. `pnpm dev` (com `.env` preenchido) + túnel ativo.
2. Envie "oi" do seu celular verificado para o número de teste.
3. Confira no log: mensagem persistida → turno agregado (4 s) → resposta via outbox
   (o conteúdo da resposta chega com o runtime da spec 005).
4. **Anexar screenshot da ida e volta no PR da 004** (critério de aceite).

## Diagnóstico rápido

| Sintoma | Causa provável |
| --- | --- |
| Webhook não verifica | `WA_VERIFY_TOKEN` diferente do digitado na Meta |
| POST /webhook → 401 | `WA_APP_SECRET` errado (HMAC não bate) |
| Mensagem não chega | campo **messages** não assinado no webhook |
| Envio falha 401/190 | token expirado (usar System User token) |
| `janela_fechada` no outbox | contato não mandou mensagem nas últimas 24 h |
