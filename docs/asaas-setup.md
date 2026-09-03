# Asaas — setup do sandbox (spec 014)

O fluxo de pagamento pelo WhatsApp usa o Asaas como provedor (ADR 0001). Sem chave o
server sobe com o **PSP simulado** (links e códigos fictícios, tudo em memória) — a demo e
os testes funcionam assim. Este guia é para ligar o **sandbox real**.

## 1. Conta e chave

1. Crie uma conta em <https://sandbox.asaas.com/> (é separada da produção).
2. Em *Integrações → Chaves de API*, gere uma chave **do sandbox**.
3. No `.env`:

   ```
   ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3
   ASAAS_API_KEY=<chave do sandbox>
   ASAAS_WEBHOOK_TOKEN=<qualquer segredo com 32 a 255 caracteres>
   ASAAS_WEBHOOK_EMAIL=<e-mail que recebe avisos de fila interrompida>
   ```

   O log de boot mostra `psp: asaas-sandbox`. Chave de sandbox com base URL de produção
   (ou vice-versa) dá `invalid_environment` — nunca misture.

## 2. Webhook (confirmação de pagamento)

O Asaas precisa alcançar `POST /webhooks/asaas` do seu server. Em dev, o túnel do
`pnpm dev-whatsapp` registra (ou atualiza) um webhook chamado `seta-dev` apontando para
`https://<túnel>/webhooks/asaas` com o `authToken = ASAAS_WEBHOOK_TOKEN`, e o
**desliga** no Ctrl+C (a URL do quick tunnel morre junto). Eventos assinados:
`PAYMENT_CREATED, PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_OVERDUE, PAYMENT_DELETED,
PAYMENT_REFUNDED, PAYMENT_RECEIVED_IN_CASH_UNDONE`.

Em produção, cadastre o webhook uma vez em *Integrações → Webhooks* com a URL pública do
server e o mesmo token.

O server valida o header `asaas-access-token` em tempo constante, grava o evento pelo id
(reentrega = 200 sem reprocessar) e responde 200 na hora; o processamento é assíncrono.
Se o Asaas registrar 15 falhas seguidas, a fila é interrompida — reative em *Webhooks*.

## 3. Simular o pagamento

No sandbox o boleto e o PIX não são pagáveis de verdade. Use **Simular pagamento** na
página *Cobranças* do console (só com `DEV_SIMULATOR=true`): o server chama
`POST /payments/{id}/receiveInCash`, o Asaas marca como recebido e **dispara o webhook
real** — o mesmo caminho da produção. Com o PSP simulado, o botão injeta o evento
diretamente na fila.

## 4. O que o fluxo exige do cadastro

- **CPF do titular** no vínculo (`documento` no `contatos.yaml`): o Asaas exige `cpfCnpj`
  para criar o cliente e o ERP não expõe CPF ao papel de leitura. Sem ele o fluxo
  bloqueia e escala para um atendente.
- Conta sandbox sem chave Pix cadastrada gera QR dinâmico válido até 23:59 do dia.

## 5. Limites (env)

| Variável | Default | Efeito |
|---|---|---|
| `PAGAMENTO_TETO_SEM_HITL_CENTAVOS` | 500000 | acima disso a cobrança espera aprovação no console |
| `PAGAMENTO_MAX_COBRANCAS_DIA` | 3 | por conversa; além disso, humano |
| `PAGAMENTO_DIAS_VENCIMENTO` | 3 | vencimento da cobrança no PSP = hoje + N |
| `PAGAMENTO_FLUXO_EXPIRA_MIN` | 60 | fluxo sem resposta sai da frente do agente |
| `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` | — | modelo aprovado (013) para avisar fora da janela de 24h |
