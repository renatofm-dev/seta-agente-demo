# Roteiro da demo (000/011/012) — Mirante da Serra Resort

Meta: os 4 atos ao vivo, do celular, em **< 10 minutos**, sem tocar em terminal.
Plano B: simulador web (`/simulador`, logado no console) executa o MESMO roteiro
se a Meta falhar no dia.

## Checklist pré-demo (30 min antes)

- [ ] `demo-seed.sh` rodado (idempotente — pode repetir na hora). **Inclui
      `kb:ingest`**: sem reindexar, o RAG ainda responde que reserva é com a
      central e o agente se contradiz no Ato 6.
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
3. **"posso trocar a data de uma reserva que já confirmei?"**
   → agente ADMITE não saber e escala: troca de data e calendário de temporada
   seguem com a central — limitação REAL do domínio, não encenada.
   Narrar: "ele não inventa — regra inegociável do prompt + guardrails".
   (Até a 038 quem fazia esse papel era "quero reservar minha semana". Agora ele
   RESERVA — é o Ato 6 —, e a prova de honestidade mudou de âncora em vez de
   sumir: é o momento mais persuasivo da demo.)

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

## Ato 5 — Cobrança de ponta a ponta (014, ~3 min)

Do número **…0002** (inadimplente), com a página **Cobranças** aberta no
browser do atendente:

12. **"quero pagar"** → o agente de cobrança lista as parcelas vencidas + a
    próxima (valores reais do ERP) e "Todas as vencidas".
13. **"1"** → escolhe a mais antiga; **"2"** → PIX; **"sim"** → "gerando seu
    PIX" e, em seguida, DUAS mensagens: a explicação e o código copia-e-cola
    sozinho (é só copiar). Narrar: "o valor nunca vem do modelo — veio do
    ERP pelo catálogo; o modelo só interpretou a escolha".
14. Na página **Cobranças** a cobrança aparece como "Aguardando pagamento" com o
    link. Clicar **Simular pagamento** (sandbox do Asaas: `receiveInCash` →
    webhook real; PSP simulado: evento injetado no mesmo caminho).
15. O celular recebe **"Pagamento confirmado! ✅ …"** e a cobrança vira "Paga".
    Perguntar **"o que está vencido?"** → a parcela paga **não aparece mais** e o
    resumo da inadimplência foi recalculado. Narrar: "a baixa está na nossa
    tabela `pagamento`, espelhando o que o ERP faria; o ERP continua read-only".
16. Bônus de guardrail: com `PAGAMENTO_TETO_SEM_HITL_CENTAVOS` baixo, "todas as
    vencidas" no cartão cai em **"Aguardando aprovação"** — aprovar no console
    emite o link; do número **…0003** (distrato em análise) "quero pagar"
    bloqueia e escala. E **"quero comprar mais uma cota"** vai para o comercial
    com texto próprio, não mais "outro canal".

## Ato 6 — Reserva de ponta a ponta (038, ~3 min)

Do número **…0001** (em dia), com a página **Reservas** aberta no browser do
atendente. É o ato que era, até agora, o exemplo de limitação:

17. **"quero usar minha semana em maio"** → o agente pergunta o período.
18. **"de 10/05 a 13/05"** → lista as torres; **"1"** → lista os tipos de
    unidade; **"1"** → pergunta quantas pessoas; **"2 adultos"**.
19. → **a simulação vem do ERP**: pontos da diária e taxa de manutenção, período
    a período. Narrar: "esses pontos e essa taxa não são nossos — vieram do
    `SimularUtilizacaoContrato` do TS Explorer, diária a diária".
20. **"sim"** → "estou registrando a reserva". Em segundos chega **"Reserva
    confirmada! … (nº 12)"**, e na página **Reservas** ela aparece como
    *Confirmada* com o número do ERP. Conferir no banco do ERP:
    `select idutilizacao, status from tse_sim.utilizacaocontrato;`
21. Bônus de honestidade: pedir **janeiro num tipo LUXO** → o agente diz que o
    período está bloqueado **citando a data** e não oferece alternativa
    inventada. Bônus de HITL: com `RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS` baixo, a
    reserva cai em **"Aguardando aprovação"** e só vai ao ERP depois do clique
    do atendente.

Narrar no fim: "a reserva existe no ERP com o nome do operador do agente — o
sistema do cliente sabe distinguir o que o robô fez do que uma pessoa fez."

## Ato 7 — Venda de ponta a ponta (045, ~4 min)

De um número **sem vínculo** (um lead frio de verdade — use o simulador se não
tiver um chip à mão), com a página **Vendas** aberta. É o ato que fecha o ciclo
comercial: até a 044 o lead do SDR morria numa tabela nossa.

22. **"quero comprar uma cota"** → o agente qualifica: quantas pessoas viajam,
    quantos períodos por ano.
23. **"4"** e **"2"** → ele lista o **estoque real** (`v_cota_disponivel`), as
    três mais baratas com tier e modelo distintos, com valor de tabela.
24. **"1"** → oferta na tabela. **"consegue melhorar?"** → vai ao **piso da
    alçada** (3%), falando em VALOR, nunca em percentual.
25. **"fechado"** → o fluxo pede **nome completo e CPF**. Narrar: "ele só pede
    dado pessoal depois que o negócio está de pé — e o CPF sai de um parser
    determinístico, nunca da saída do modelo".
26. **"Joana Pereira Lima, CPF 000.354.175-44"** → chega o **card do PIX**:
    valor do sinal, vencimento, link de pagamento e o botão *Copy Pix code* com
    o copia-e-cola. É o template `cobranca_pix`, aprovado na WABA.
27. **Pagar no sandbox do Asaas** (ou disparar o webhook de teste) → em segundos
    chega **"Pagamento confirmado e contrato registrado! Seu contrato é o
    nº …"**, e a página **Vendas** mostra *Contrato criado*.
28. Conferir no ERP que o contrato existe de verdade, com as parcelas:
    ```sql
    select c.idcontrato, c.statuscontrato, p.nome, count(f.*) as parcelas
      from contrato c join pessoa p on p.idpessoa = c.idpessoatitular
      left join contafinanceira f on f.idcontrato = c.idcontrato
     where c.idcontrato = <o número> group by 1,2,3;
    ```
29. Bônus: repetir a mesma pergunta do **número do Renato (cotista)** → ele
    entra no mesmo fluxo **sem pedir CPF**, porque o cadastro já tem.

Narrar no fim: "o lead virou cotista no ERP do cliente sem ninguém digitar nada
— e nenhuma linha foi escrita antes de o dinheiro entrar."

Fechamento: "tudo isso rodando numa VPS de €4, com o LLM atrás de um port —
levar para dentro de casa é trocar duas variáveis de ambiente."

## Se a Meta falhar (plano B)

Logar no console → `/simulador` → executar as MESMAS mensagens acima (o
simulador injeta no mesmo caminho do webhook; exige sessão em produção).
