# 038 — Reserva de utilização de contrato pelo agente

> **Entregue em 16/09/2026.** Quarta fatia da frente **demo ponta a ponta**. O que saiu está em
> [`docs/dev/04-modulos-entregues.md`](../docs/dev/04-modulos-entregues.md); o ato novo em
> [`docs/roteiro-demo.md`](../docs/roteiro-demo.md).
>
> **Decisões do Renato, registradas antes de começar:** escopo completo **com tela própria no
> console**; o agente age como **operador dedicado** (`TSE_RESERVA_USERNAME`), porque o TSE grava
> `IdOperadorRespSolicitacao` e é isso que separa robô de humano na auditoria; e **teto de HITL
> próprio** (`RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS`), porque aqui a aprovação não segura dinheiro
> nosso, segura o compromisso do cotista com uma taxa que o ERP vai faturar.
>
> **O que mudou em relação ao desenho da spec:**
>
> 1. **A escrita é 1 chamada, não 1+N.** `CriarUtilizacaoContrato` aceita `ListaHospedes` inline —
>    `AdicionarHospede` saiu do caminho feliz, e com ele a maior fonte de não-idempotência.
> 2. **A simulação acontece em `pagantes`, antes dos hóspedes.** Se viesse no fim, o cotista
>    entregaria o CPF de quatro pessoas para ouvir "não tem pontos". Os dois encerramentos que vêm
>    do ERP acontecem sem nenhum dado pessoal coletado.
> 3. **O hóspede principal é o titular**, com o CPF que a plataforma já tinha (014) — o que reduz a
>    superfície do CPF a zero na maioria das reservas.
> 4. **Inadimplência não bloqueia reserva**: quem decide isso é o TSE
>    (`PercentualMinimoIntegralizadoExigido`); bloquear por conta própria seria regra nossa.
>    Pergunta em aberto ao fornecedor.
> 5. **`Sexo` do hóspede vai nulo** — o TSE pede e o espelho não tem o dado. Outra pergunta.

## Objetivo
A persona em `configs/demo/client.yaml` diz, hoje, que reserva e calendário "são com a central de
atendimento" — e o roteiro de demo usa isso como **prova de honestidade** do agente ("ele não
inventa"). Isso é verdade porque o espelho do TS Explorer não tem reserva: a
[012](012-dominio-multipropriedade.md) levantou as 36 tabelas replicadas e registrou que reserva,
calendário, check-in e hospedagem **não existem** ali.

A API tem. `SimularUtilizacaoContrato`, `CriarUtilizacaoContrato`, `AdicionarHospede`,
`ConfirmarUtilizacaoContrato` — o ciclo inteiro. Esta spec transforma o ato mais honesto da demo no
ato mais forte: o cotista pede a semana, o agente simula os pontos e a taxa, confirma e **cria a
reserva no ERP**.

## Reaproveita
- `packages/cobranca` — o molde exato: máquina de estados determinística e pura
  (`selecao → metodo → confirmacao → encerrado`), `parser.ts` determinístico, `interpretar.ts` por
  LLM só quando o parser não resolve, `render.ts` com os textos.
- `packages/agent/src/tools-internas.ts` — `toolIniciarPagamento` é uma `ToolSpec` que **não faz
  nada** além de retornar `{ok:true}` e ser interceptada pelo grafo; `toolIniciarReserva` é igual.
- `apps/server/src/wa/turno-handler.ts:401-423, 562-573` — fluxo ativo consome o turno; as tools do
  server são injetadas ali.
- `apps/server/src/pagamentos/{fluxo,repo,escalar}.ts` e `tool-cobranca-em-aberto.ts` — molde de
  fluxo persistido, HITL e `ToolSpec` de leitura escrita no server.
- `packages/erp-api-tse` (036) — `ErpWriter` ganha os métodos de utilização; `erp_escrita` ganha
  `operacao='reserva'`.
- `apps/tse-sim` (035) — as rotas de utilização entram aqui.

## Escopo

### Simulador (`apps/tse-sim`)
`utilizacaocontrato/{ObterHoteis, ObterTiposUnidadeHoteleira, ObterTiposPensao,
ObterTiposFaixaEtaria, SimularUtilizacaoContrato, CriarUtilizacaoContrato, AdicionarHospede,
RemoverHospede, AdicionarTaxaManutencao, ConfirmarUtilizacaoContrato, CancelarUtilizacaoContrato,
ObterTotalReceberPorTipo}` e `PainelDoCliente/{HoteisDisponiveisUso, TiposUnidadeHoteleira,
SimularUtilizacaoContrato, CriarSolicitacaoReserva, MinhasUtilizacoesContrato}`, com persistência
em `tse_sim.{utilizacaocontrato, hospede, tipopensao}`.

### Adapter
`ErpWriter.{simularUtilizacao, criarUtilizacao, adicionarHospede, confirmarUtilizacao,
cancelarUtilizacao}` + as leituras tipadas de hotéis e tipos de UH.

### `packages/reserva` (domínio puro, novo)
Máquina `periodo → hotel → unidade → hospedes → confirmacao → encerrado`, parser determinístico
(datas, número de adultos/crianças, CPF), `render.ts`. Sem banco, sem rede — como `packages/cobranca`.

### Servidor
`apps/server/src/reserva/{fluxo,repo,worker}.ts`, tabelas `fluxo_reserva` e `reserva`
(`unique` parcial de 1 fluxo ativo por conversa, como `fluxo_cobranca_ativo_uq`), `ToolSpec`s de
leitura (`hoteis_disponiveis`, `simular_reserva`) injetadas no `turno-handler`, e a escrita como
**job pg-boss** disparado só após confirmação textual explícita. A taxa de manutenção acima do teto
passa pelo HITL, no molde da aprovação de cobrança.

### Console e persona
Drawer de reserva no `/inbox` (ou tela própria, a decidir); `configs/demo/client.yaml` perde a
frase de que não sabe reservar; ato novo em `docs/roteiro-demo.md`.

## Fora de escopo
- Pagamento da taxa por cartão (`EfetuarPagamentoCartaoCredito`) — o fluxo da 014 já cobre cobrança.
- Cancelamento com multa (`CriarTaxaCancelamento`).
- Intercâmbio, crédito de fracionamento, market/block code.
- Calendário visual no console.

## Premissas
- **`CriarSolicitacaoReserva` devolve 200 vazio** — sem id, não dá para confirmar nem cancelar. A
  jornada usa o caminho de operador (`CriarUtilizacaoContrato` → `IdUtilizacaoContrato` →
  `ConfirmarUtilizacaoContrato/{id}`). Isso significa que **o agente age como operador do
  sistema**: é decisão de política e requisito de auditoria (quem foi o operador? há registro?).
  Levantar antes de começar, não descobrir na demo.
- **CPF de hóspede vs. anonimização.** `CriarUtilizacaoContrato` exige CPF de cada hóspede, e
  `packages/anonimizacao` troca CPF por token estável no que vai para a LLM. O CPF **tem** que sair
  do texto cru pelo parser determinístico, nunca da saída estruturada do modelo. Teste nomeado
  obrigatório.
- O LLM nunca escreve: a escrita só acontece dentro de worker, depois de confirmação capturada por
  máquina determinística, sob chave de idempotência (`erp_escrita`).

## Critérios de aceite
- "quero usar minha semana em julho" → o agente pergunta o que falta (datas, hotel, tipo de UH,
  quantos vão), mostra a simulação com **pontos e taxa vindos do ERP**, pede confirmação explícita.
- Confirmado: `IdUtilizacaoContrato` criado e confirmado no TSE; `MinhasUtilizacoesContrato` passa
  a listar; a reserva aparece no console.
- Taxa acima do teto: fica em `aguardando_aprovacao`, o atendente decide no console, o cotista
  recebe a resposta.
- Reenvio/retry não cria segunda utilização (`erp_escrita` com `operacao='reserva'`).
- CPF de hóspede extraído do texto cru: teste que prova que o token de anonimização **não** chega
  ao ERP.
- Pontos insuficientes ou período bloqueado ⇒ o agente explica com o dado do ERP e não inventa
  alternativa.
- `pnpm lint && pnpm test && pnpm build` verdes.

## O que dá para demonstrar ao final
O ato mais forte da demo. "Quero reservar minha semana de janeiro" deixa de ser o exemplo de
honestidade do agente e passa a ser uma reserva criada, confirmada e visível no ERP.

## Decisões a resolver (registrar a escolha na descrição do PR)
- O agente age como qual operador do TSE? Credencial dedicada com rastro próprio?
- Teto da taxa de manutenção sem HITL (reusar `PAGAMENTO_TETO_SEM_HITL_CENTAVOS` ou próprio).
- Reserva no drawer do `/inbox` ou tela própria no console.
