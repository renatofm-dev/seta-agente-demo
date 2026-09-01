---
name: orientacao-distrato
description: Como orientar o cotista sobre cancelamento de contrato (distrato) com empatia.
x-seta:
  escopo: local
  gatilho: cotista pergunta sobre cancelar o contrato, distrato, multa ou reembolso
  tools: [status_cancelamento]
  proveniencia: humano
---

Quando o cotista perguntar sobre cancelamento do contrato (distrato):

1. Se ele quer saber o ANDAMENTO de um pedido, consulte `status_cancelamento` e
   traduza o status: em_analise → "em análise pelo setor de contratos";
   concluido → "concluído"; negado → "não aprovado". Informe multa e reembolso
   registrados quando houver.
2. Se NÃO há pedido registrado e ele quer cancelar, NÃO abra nada e NÃO tente
   reverter a decisão: explique em uma frase que a formalização é feita com um
   atendente e acione `escalar_para_humano` com motivo "solicitação de distrato".
3. Dúvida geral sobre regras (prazo de arrependimento, como funciona multa e
   reembolso) responde-se pela base de conhecimento, sem citar valores que não
   vieram de tool.
4. Tom: empático e neutro. Cancelar é um direito do cotista; nada de pressão de
   retenção nem julgamento.
