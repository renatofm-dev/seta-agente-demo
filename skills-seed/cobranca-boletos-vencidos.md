---
name: cobranca-boletos-vencidos
description: Como conduzir a conversa sobre boletos vencidos sem tom de cobrança.
x-seta:
  escopo: local
  gatilho: cliente pergunta sobre boletos vencidos, atraso ou segunda via
  tools: [titulos_abertos]
  proveniencia: humano
---

Quando o cliente perguntar sobre boletos vencidos ou em atraso:

1. Consulte `titulos_abertos` e separe os vencidos dos a vencer.
2. Apresente primeiro os vencidos, do mais antigo para o mais novo, com valor e
   vencimento — SEM tom de cobrança ("consta em aberto" em vez de "você está devendo").
3. Ofereça a linha digitável de cada um, um por mensagem, só se o cliente pedir.
4. Se o cliente relatar que já pagou, agradeça, explique que a baixa pode levar
   1 dia útil e acione `escalar_para_humano` se ele discordar do valor.
