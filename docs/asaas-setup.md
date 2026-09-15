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
   ASAAS_API_KEY='<chave do sandbox>'
   ASAAS_WEBHOOK_TOKEN=<qualquer segredo com 32 a 255 caracteres>
   ASAAS_WEBHOOK_EMAIL=<e-mail que recebe avisos de fila interrompida>
   ```

   **As aspas simples na chave não são enfeite.** A chave do Asaas começa com `$`
   (`$aact_hmlg_…` no sandbox, `$aact_prod_…` em produção) e o `tools/dev-whatsapp.sh`
   sourceia o `.env` pelo shell: sem aspas, `$aact_hmlg_…` é expandido como variável
   indefinida e vira string vazia. O server (que lê pelo `--env-file` do Node, sem
   expansão) funciona normalmente, então o sintoma é só o script imprimir
   *"(sem ASAAS_API_KEY/ASAAS_WEBHOOK_TOKEN no .env: PSP simulado, sem webhook)"* e o
   pagamento nunca confirmar sozinho.

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
página *Cobranças* do console (exige `DEV_SIMULATOR=true` **e** ambiente diferente de
produção — em produção a rota responde 404 e o botão não aparece): o server chama
`POST /payments/{id}/receiveInCash`, o Asaas marca como recebido e **dispara o webhook
real** — o mesmo caminho da produção. Com o PSP simulado, o botão injeta o evento
diretamente na fila.

## 4. O que o fluxo exige do cadastro

- **CPF do titular** no vínculo (`documento` no `contatos.yaml`): o Asaas exige `cpfCnpj`
  para criar o cliente e o ERP não expõe CPF ao papel de leitura. Sem ele o fluxo
  bloqueia e escala para um atendente.
- A validade do QR Pix vem do Asaas, não do nosso código, e o formato **não é ISO**
  (`2027-09-18 23:59:59`) — por isso `cobranca.pix_expira_em` é `text`. Não tente parsear
  como data sem tratar.

## 5. Limites (env)

| Variável | Default | Efeito |
|---|---|---|
| `PAGAMENTO_TETO_SEM_HITL_CENTAVOS` | 500000 | acima disso a cobrança espera aprovação no console |
| `PAGAMENTO_MAX_COBRANCAS_DIA` | 3 | por conversa; além disso, humano |
| `PAGAMENTO_DIAS_VENCIMENTO` | 3 | vencimento da cobrança no PSP = hoje + N |
| `PAGAMENTO_FLUXO_EXPIRA_MIN` | 60 | fluxo sem resposta sai da frente do agente |
| `WA_TEMPLATE_PAGAMENTO_CONFIRMADO` | — | modelo aprovado (013) para avisar fora da janela de 24h |

## 6. Diagnóstico — o que a primeira execução real mostra

Validado contra o sandbox em 15/09/2026 (spec 042). A ordem abaixo é a de quem está
debugando "a cobrança não confirma".

| Sintoma | Causa | O que fazer |
|---|---|---|
| Boot loga `psp: simulado` | `ASAAS_API_KEY` ausente ou comentada | o switch é só a presença da chave (`apps/server/src/index.ts:63-66`) |
| Boot loga `psp: asaas-producao` | `ASAAS_BASE_URL` de produção | o ambiente sai da base URL por regex `/sandbox/i` |
| `invalid_environment` na primeira chamada | chave de um ambiente com base URL do outro | nunca misture sandbox e produção |
| `pnpm dev-whatsapp` diz "sem ASAAS_API_KEY" mesmo com a chave no `.env` | chave começa com `$` e está sem aspas (ver §1) | `ASAAS_API_KEY='$aact_…'` |
| Cobrança emitida, mas nunca vira `paga` | o webhook não chega | conferir a linha `webhook Asaas seta-dev: <id> ✔` no `pnpm dev-whatsapp`; sem túnel, o Asaas marca como recebida e o nosso lado fica em `emitida` |
| Webhook parou sozinho | 15 falhas seguidas interrompem a fila do Asaas | reativar em *Integrações → Webhooks*; o aviso vai para `ASAAS_WEBHOOK_EMAIL` |
| Evento recebido mas não processado | `erro` preenchido e `processado_em` nulo | ver abaixo |

### Evento preso, e como reprocessar

Um evento que falhou fica com `erro` preenchido e `processado_em` **nulo**. A reentrega do
Asaas não ajuda: ela bate na idempotência por id (`onConflictDoNothing`) e não gera job
novo. O caso mais comum é `cobrança desconhecida` — o `payment.id` não resolve para
nenhuma cobrança nossa (cobrança criada à mão no painel do sandbox, ou base de dados
recriada depois da emissão).

A tela *Cobranças* mostra a contagem de pendentes acima dos filtros; o link **ver** abre a
lista com o motivo de cada um e um botão **Reprocessar**. Essa lista é a única superfície
que enxerga eventos órfãos — o drawer da cobrança só mostra os que pertencem a ela.

Pela API:

```sh
curl -b cookies.txt 'http://localhost:3001/api/console/eventos-psp?pendente=true'
# o id do Asaas é `evt_<hash>&<sequência>` — contém `&`, precisa de encode no path
curl -b cookies.txt -X POST \
  'http://localhost:3001/api/console/eventos-psp/evt_abc%26123/reprocessar'
```

Reprocessar um evento já processado é no-op (200, `reenfileirado: false`), não erro.
Erro de **payload inválido** é terminal: o corpo gravado não muda, então o evento sai da
fila de pendentes com a mensagem preservada.
