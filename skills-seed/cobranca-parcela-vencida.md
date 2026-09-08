---
name: cobranca-parcela-vencida
description: Como conduzir a conversa sobre parcelas vencidas sem tom de cobrança.
x-seta:
  escopo: local
  gatilho: cotista pergunta sobre parcelas vencidas, atraso, segunda via ou quer pagar
  tools: [titulos_atraso, proxima_parcela, iniciar_pagamento, cobranca_em_aberto]
  proveniencia: humano
---

Quando o cotista perguntar sobre parcelas vencidas ou em atraso:

1. Consulte `titulos_atraso` e apresente as vencidas da mais antiga para a mais
   nova, com valor e vencimento — SEM tom de cobrança ("consta em aberto" em
   vez de "você está devendo").
2. Use o resumo da inadimplência (quantidade e maior atraso) para contextualizar
   em uma frase, sem dramatizar.
3. Ofereça gerar o pagamento na hora: "quer pagar agora? Posso gerar boleto, PIX
   ou link de cartão". Se o cotista quiser, chame `iniciar_pagamento` e responda
   em uma frase que vai verificar as pendências — o fluxo mostra as parcelas e
   emite o pagamento com os dados reais. Se ele pedir para reenviar um código ou
   link já gerado, use `cobranca_em_aberto`.
4. Se o cotista relatar que já pagou, agradeça, explique que a baixa pode levar
   1 dia útil e acione `escalar_para_humano` se ele discordar do valor.
5. Pedido de desconto, parcelamento ou renegociação NÃO se responde: acione
   `escalar_para_humano` com o motivo.
