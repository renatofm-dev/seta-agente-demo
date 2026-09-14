# 039 — O SDR escreve no ERP: lead (`setcasal`) e venda (`SetVenda`)

> **Pré-spec** (rascunho de 14/09/2026): ainda não executada. Quinta fatia da frente
> **demo ponta a ponta**. Depende da **036** (`ErpWriter`) e da
> [015b](015b-sdr-aprovacao-console.md) (a aprovação humana é o gatilho da escrita).
> Tamanho **G**.

## Objetivo
A raia do lead frio (015/015a) qualifica, apresenta o estoque e monta a proposta — e termina ali:
o lead vira linha nas tabelas do produto e nada disso chega ao ERP. A API do TSE tem o ciclo
comercial inteiro: `recepcaots/setcasal` (o "casal", que é o lead no vocabulário do TS Explorer) e
`vendats/SetVenda`, que devolve `"IdContrato: 285"` — um contrato de multipropriedade criado.

Esta spec fecha o ciclo comercial: lead qualificado vira registro no ERP, e a proposta **aprovada
por um humano** vira venda.

## Reaproveita
- `packages/sdr` — máquina `qualificacao → apresentacao → oferta → agendamento → encerrado`,
  parser determinístico, aritmética inteira do piso em bps.
- `apps/server/src/sdr/{fluxo,escalar,repo,leads-routes}.ts` e a tela de Leads.
- **015b** — `POST /api/console/leads/:id/propostas/:pid/aprovar` é o gatilho: a escrita no ERP é
  efeito da aprovação, não do agente.
- `packages/erp-api-tse` (036) — `ErpWriter` ganha `criarLead`/`criarVenda`; `erp_escrita` ganha
  `operacao='lead'|'venda'`.
- `packages/guardrails/src/preco.ts` e o `price_source` do catálogo — o piso continua sendo a
  política nossa.

## Escopo

### Simulador (`apps/tse-sim`)
`recepcaots/{setcasal, GetCasal, GetCasaisPorPeriodo}`, `vendats/SetVenda`,
`cadastros/SetPessoa`, e os `Lookup/{Produtos, CotasByProduto, OrigensVenda, TiposRelacionamento,
MeiosPagamentoContasReceber, BandeirasCartao}` que o corpo de `SetVenda` referencia. Persistência
em `tse_sim.casal` e, para a venda, linhas reais em `contrato` + `contafinanceira` (é o que faz a
demo fechar: o lead vira cotista e passa a ter parcelas).

### Adapter
`ErpWriter.criarLead(LeadInput) → {casalId}` e `criarVenda(VendaInput) → {contratoId}`. A resposta
de `SetVenda` é **prosa** (`"IdContrato: 285"`): regex estrita, `ErpBusinessError` se não casar.

### Servidor
- Lead qualificado ⇒ job `FILA_ERP_LEAD` grava o casal no TSE e guarda o `casalId` no lead.
- Proposta **aprovada no console** (015b) ⇒ job `FILA_ERP_VENDA`.
- **Guardrail de escrita:** a venda só é enviada com proposta em estado `aceita`, decidida por
  humano, e valor **≥ piso** (`valor_minimo_centavos` da entrada `price_source`). Valor abaixo do
  piso sem aprovação ⇒ recusa com erro auditado, nunca escrita.

## Fora de escopo
- Migrar `comercial.*` para HTTP — `IdentificadorUnicoCota` (`"TORRE 1-TORRE 01-01-101A-DIAMANTE-A"`)
  exigiria parse de string composta, que não cabe no vocabulário fechado da projeção (ver 037).
- Financiamento, indexadores, cartão recorrente e o corpo completo de `SetVenda` — só o mínimo
  para criar um contrato à vista com entrada.
- Prospecção ativa e raia do cotista (031).

## Premissas
- "Casal" é o lead no vocabulário do TS Explorer; o corpo de `setcasal` tem dois compradores, e o
  nosso lead frio pode ter um só. `Nome2`/`Cpf2` vazios precisam ser aceitos pelo simulador — e é
  pergunta ao fornecedor se o TSE real aceita.
- O CPF do lead vem do texto cru pelo parser determinístico, nunca da saída do modelo (mesma
  armadilha da 038).
- Escrita comercial é irreversível do ponto de vista do cliente: **nunca** sem decisão humana
  registrada.

## Critérios de aceite
- Lead frio conversa, qualifica, recebe proposta acima do piso → aceita → `setcasal` grava o casal
  e o lead guarda o `casalId`.
- Proposta abaixo do piso → para no console (015b) → atendente aprova → `SetVenda` cria o contrato
  → `obtercontratos?cpf=` do lead passa a devolver o contrato novo, com parcelas.
- Tentativa de venda sem aprovação humana, ou abaixo do piso, é recusada e auditada.
- Reprocessar o job não cria segundo casal nem segundo contrato (`erp_escrita`).
- `200` com prosa inesperada vira erro, não sucesso.
- `pnpm lint && pnpm test && pnpm build` verdes.

## O que dá para demonstrar ao final
Lead frio → qualificação → proposta → aprovação no console → **contrato criado no ERP**. O ciclo
comercial inteiro, com a decisão de preço sempre num humano.

## Decisões a resolver (registrar a escolha na descrição do PR)
- `IdPromotorMarketing`/`IdOrigemCasal`/`IdLocalCaptacao` do lead vindo do WhatsApp — que códigos
  o cliente usa para "originado pelo agente"?
- Lead vira casal no ERP na qualificação ou só quando há proposta aceita?
- Venda à vista com entrada é suficiente para a demo, ou precisa de parcelamento?
