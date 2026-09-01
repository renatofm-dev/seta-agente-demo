---
name: cobranca-parcela-vencida
description: Como conduzir a conversa sobre parcelas vencidas sem tom de cobrança.
x-seta:
  escopo: local
  gatilho: cotista pergunta sobre parcelas vencidas, atraso ou segunda via
  tools: [titulos_atraso, proxima_parcela]
  proveniencia: humano
---

Quando o cotista perguntar sobre parcelas vencidas ou em atraso:

1. Consulte `titulos_atraso` e apresente as vencidas da mais antiga para a mais
   nova, com valor e vencimento — SEM tom de cobrança ("consta em aberto" em
   vez de "você está devendo").
2. Use o resumo da inadimplência (quantidade e maior atraso) para contextualizar
   em uma frase, sem dramatizar.
3. Ofereça a linha digitável ou o PIX copia-e-cola de cada parcela, um por
   mensagem, só se o cotista pedir.
4. Se o cotista relatar que já pagou, agradeça, explique que a baixa pode levar
   1 dia útil e acione `escalar_para_humano` se ele discordar do valor.
5. Pedido de desconto, parcelamento ou renegociação NÃO se responde: acione
   `escalar_para_humano` com o motivo.
