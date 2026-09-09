# 031 — SDR fase 2: prospecção ativa, raia do cotista e parcelamento

> **Pré-spec / rascunho M5** (08/09/2026): "fora de escopo" da 015. Depende da 015b, da 023
> (templates comerciais aprovados — V-03) e do piloto.

## Objetivo
O SDR de hoje é reativo e só para número sem vínculo. A fase 2 abre três frentes: iniciar
conversa com leads frios (prospecção ativa, com template aprovado e compliance), atender o
cotista que quer outra cota ou upgrade (raia do cotista, hoje escala), e falar em
parcelamento (hoje o SDR só oferta à vista na tabela ou no piso).

## Reaproveita
- `packages/sdr` (máquina, parser, textos), `catalog/comercial/`, 015b (aprovação humana).
- 013/030 (disparo com template) para a prospecção.
- `v_contrato_cota` + `estoque_disponivel` para o upgrade.
- Guardrail de preço com `price_source` (a alçada continua a mesma).

## Escopo
- **Prospecção ativa**: lista de leads importada (CSV pelo console, com origem e
  consentimento registrados), template comercial aprovado (`V-03`), envio pelo worker da
  030, resposta cai no SDR; opt-out obrigatório na primeira mensagem.
- **Raia do cotista**: `interesse_compra` com vínculo inicia o SDR com contexto do contrato
  atual (tier, períodos), oferta de upgrade/cross-sell; o fluxo de cobrança da 014 não é
  tocado; persona híbrida.
- **Parcelamento**: `condicoes_cota` devolve também `parcelas_max` e `entrada_minima`;
  a máquina ganha a etapa `condicoes` (à vista × parcelado) e o texto fala em número de
  parcelas e valor, nunca em juros ou percentual; guardrail aceita os pontos da tool.
- Métricas do SDR no console (leads por etapa, tempo até agendamento, taxa de aprovação
  humana) e no relatório (017) como origem "SDR".

## Fora de escopo
- Assinatura de contrato pelo WhatsApp; integração com CRM externo.
- Precificação dinâmica.

## Premissas
- Prospecção só com base legal e opt-out; a Meta pune número com spam — ritmo e qualidade
  (023) mandam.

## Critérios de aceite
- Lead importado recebe o template, responde e é qualificado pelo SDR; cotista pedindo
  upgrade recebe oferta com base no contrato atual; parcelamento ofertado em valor por
  parcela sem percentual (varredura); métricas do SDR visíveis.
