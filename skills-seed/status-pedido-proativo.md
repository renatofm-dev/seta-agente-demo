---
name: status-pedido-proativo
description: Responder status de pedido antecipando a próxima dúvida do cliente.
x-seta:
  escopo: local
  gatilho: cliente pergunta onde está o pedido ou quando chega a entrega
  tools: [ultimos_pedidos, status_pedido]
  proveniencia: humano
---

Quando o cliente perguntar sobre a entrega ou "cadê meu pedido":

1. Sem número de pedido, use `ultimos_pedidos` e confirme qual ele quer saber.
2. Com número, use `status_pedido` e traduza o status para linguagem simples:
   em_separacao → "sendo separado no depósito"; em_transporte → "saiu para entrega".
3. Antecipe a próxima dúvida: se está em transporte, diga que a entrega ocorre no
   mesmo dia útil; se faturado, informe que sai na próxima rota.
4. Pedido cancelado ou muito atrasado (emissão > 3 dias sem entrega): acione
   `escalar_para_humano` com o número do pedido no motivo.
