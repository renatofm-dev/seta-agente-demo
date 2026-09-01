# Roteiro da demo (000/011/012) — Mirante da Serra Resort

Meta: os 4 atos ao vivo, do celular, em **< 10 minutos**, sem tocar em terminal.
Plano B: simulador web (`/simulador`, logado no console) executa o MESMO roteiro
se a Meta falhar no dia.

## Checklist pré-demo (30 min antes)

- [ ] `demo-seed.sh` rodado (idempotente — pode repetir na hora).
- [ ] Janela de 24h ABERTA: mandar "oi" do número de teste e receber resposta.
- [ ] Fila limpa: nenhum ticket pendurado no inbox (resolver sobras de ensaio).
- [ ] Dois browsers logados: `atendente@demo.seta` (inbox) e `curador@demo.seta`
      (aprendizado) — senhas no seed.
- [ ] `/metricas` aberta numa aba para o Ato 4 já ter dados dos ensaios.
- [ ] Celular com o número de teste no WhatsApp, tela espelhada.

## Ato 1 — Autonomia com dado real de negócio (~2 min)

Enviar do celular, nesta ordem:

1. **"quanto ainda falta pagar do meu contrato?"**
   → saldo devedor e parcelas reais do ERP mock (tool `saldo_contrato`).
2. **"qual é a minha cota? em que andar fica?"**
   → torre, andar, UH e capacidade (tool `minha_cota`).
3. **"quero reservar minha semana de janeiro"**
   → agente ADMITE não saber e escala: reserva/calendário NÃO existe no
   espelho do TS Explorer — limitação REAL do domínio, não encenada.
   Narrar: "ele não inventa — regra inegociável do prompt + guardrails".

Bônus de política (008): **"como funciona o distrato?"** → resposta citando
"Cancelamento e distrato" (KB via RAG). Bônus de dado: do número **…0003**,
**"como está meu cancelamento?"** → status do distrato em análise, com multa e
reembolso do seed (tool `status_cancelamento`).

## Ato 2 — Guardrail + HITL (~3 min)

4. **"consegue me fazer 10% de desconto nessas parcelas?"** (do número
   **…0002**, o inadimplente — antes pergunte "o que está vencido?" para ver
   a tool `titulos_atraso`)
   → agente NÃO negocia: mensagem de transição + ticket escalado
   (`negociacao_preco`). A régua de cobrança existe no ERP (`perfilcobranca`),
   mas negociar é decisão de humano — registrada na spec 012.
5. No browser do **atendente**: inbox mostra o ticket em "Aguardando humano" →
   **Assumir** → bot silencia → responder manualmente (ex.: *"Consigo sim uma
   condição especial, vou aplicar 5% nesse título, ok?"*) → **Resolver** →
   ticket volta ao bot.
   Narrar: resposta do humano vira sinal de aprendizado (correção HITL).

## Ato 3 — Auto-aperfeiçoamento (~3 min)

6. No browser do **curador**, página **Aprendizado** → **Gerar propostas**
   (distiller roda sobre os sinais dos atos 1–2).
7. Abrir a proposta (ex.: "responder-pedido-desconto"), mostrar evidência e
   diff → **Aprovar**.
8. Do celular, repetir: **"e aquele desconto, rola?"**
   → resposta melhor, guiada pelo skill aprovado (sem prometer valor, escalando
   com empatia).
9. Mostrar versionamento: lista de versões da skill; narrar rollback/kill-switch
   ("se a skill der ruim, o curador desativa na hora").

## Ato 4 — Auditabilidade (~2 min)

10. No ticket do Ato 2/3, aba **trace**: expandir o turno do desconto —
    contexto (skills usadas) → verdict do guardrail → resposta, com tokens e
    latência. Narrar: "qualquer resposta é reconstituível, sem SQL na mão".
11. Página **Métricas**: conversas/dia, taxa de resolução sem humano,
    escalonamentos por motivo, custo estimado do dia.

Fechamento: "tudo isso rodando numa VPS de €4, com o LLM atrás de um port —
levar para dentro de casa é trocar duas variáveis de ambiente."

## Se a Meta falhar (plano B)

Logar no console → `/simulador` → executar as MESMAS mensagens acima (o
simulador injeta no mesmo caminho do webhook; exige sessão em produção).
