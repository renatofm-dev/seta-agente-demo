# 012 — Domínio de multipropriedade (corrige a 002)

## Objetivo
A POC sempre foi "Agente TS Explorer" (`specs/README.md`), mas a 002 implementou uma
distribuidora de bebidas: tabelas `pcclient`/`pcpedido`/`pcprest` (Winthor), 40 SKUs,
pedidos, estoque e tabela de preço. Multipropriedade não tem nada disso. Esta spec troca
a camada de domínio inteira pela estrutura real do TS Explorer, levantada do espelho em
`bali-vps` (`bali_tse`, 36 tabelas replicadas, sync de 30/08/2026).

Nada de arquitetura muda: `agent`, `guardrails`, o executor do `query-catalog`, `wa-meta`,
RAG, HITL, aprendizado, trace e métricas são agnósticos de domínio. O que muda é o dado,
o catálogo, a base de conhecimento e a persona.

## O negócio, como o schema o revela
Resort de multipropriedade em 2 blocos, 146 unidades hoteleiras, 5.694 cotas. A unidade
vendável é a **cota** (fração de uso de uma UH), não o apartamento. Comercializada em 6
tiers (`grupocota`: OURO/DIAMANTE × PREMIUM/MASTER/SPECIAL); o `modelocota` define quantos
períodos de uso a cota confere. Contrato é híbrido cota + pontos. Financeiro é crediário
próprio longo (até 583 parcelas), cobrado por boleto e cartão recorrente. Distrato é o
problema central do negócio.

## Escopo

### Tabelas físicas (`infra/erp-mock/01-tabelas.sql`)
Espelham os nomes e colunas reais do TS Explorer — só o subconjunto que o catálogo precisa:

`edificiohotel` · `unidadehoteleira` · `grupocota` · `modelocota` · `cotauh` · `pessoa`
`contrato` · `tipoorigemcontafinanceira` · `meiopagamento` · `contafinanceira`
`cancelamento` · `motivocancelamentocontrato` · `ocorrenciaatendimentots` · `motivocontato`

Colunas: as que as views usam, com os nomes originais (`idcotauh`, `valorreceber`,
`statuscontrato`, `tipohistorico`…). Não inventar nome bonito na camada física — a
distância física→canônico é o que demonstra a camada semântica, como na 002.

### Views canônicas (`infra/erp-mock/02-views.sql`)
Substituem `v_pedido`/`v_item_pedido`/`v_estoque`/`v_tabela_preco`, que não existem neste
domínio. As views carregam as regras de negócio auditadas no espelho real:

| View | Grão | Regras que precisa embutir |
|---|---|---|
| `v_cotista` | contrato | Titular **pseudonimizado** (`'Titular do contrato NNNNN'`) — o papel `bali_agente` teve SELECT revogado em `pessoa`/`contrato` por LGPD; a view nasce dentro dessa fronteira |
| `v_contrato_cota` | contrato | `idcotaativa` com fallback para `idcotaadquirida`; bloco, andar, UH, tier, nº de períodos, pontos contratados |
| `v_titulo` | parcela | `tipohistorico='ATIVO'`; usar `datavencimentorecorrencia` como vencimento de referência (a origem **reescreve** `datavencimento` quando a recorrente é paga); sanidade de data `between '2020-01-01' and current_date + interval '30 years'` |
| `v_inadimplencia` | contrato | Agregado de vencidos: nº de títulos, saldo, vencimento mais antigo, maior atraso em dias |
| `v_cancelamento` | contrato | Último distrato por contrato (`DISTINCT ON`); status, motivo, multa, valor a reembolsar |
| `v_chamado` | ocorrência | Status, abertura, finalização, motivo |

Contrato ativo é `statuscontrato IN ('ATIVO','ATIVOREV')` — contar só `'ATIVO'` perde 22
contratos no espelho real.

### Seed (`infra/erp-mock/seed.ts`)
Proporções fiéis ao espelho, em escala reduzida: 2 blocos, ~30 UHs, ~400 cotas
(≈57% bloqueio administrativo, ≈32% vendida, ≈10% disponível), ~120 contratos
(≈58% cancelado, ≈40% ativo), parcelas Entrada + Saldo com boleto/PIX/cartão recorrente
na proporção real, alguns distratos e chamados. Datas relativas a `now()`, RNG
determinístico, idempotente — como na 002.

### Catálogo (`catalog/`)
Substitui as 6 entradas atuais pelas 8 perguntas que o schema responde de fato:

- `financeiro/saldo_contrato` — saldo devedor e parcelas restantes
- `financeiro/titulos_atraso` — o que está vencido, desde quando
- `financeiro/proxima_parcela` — vencimento + linha digitável / PIX copia-e-cola
- `financeiro/total_pago` — quanto já foi pago, quebrado por Entrada e Saldo
- `contrato/minha_cota` — bloco, andar, UH, capacidade
- `contrato/meu_produto` — tier, períodos de uso, pontos contratados
- `contrato/status_cancelamento` — situação do distrato, multa, reembolso
- `atendimento/meu_chamado` — status da ocorrência

`source: session` em `contrato_id`/`pessoa_id` — nunca do LLM, como manda o CLAUDE.md.

### KB (`kb/`), skills (`skills-seed/`) e persona (`configs/demo/client.yaml`)
KB: regulamento de uso, taxas e formas de pagamento, cancelamento e distrato, pontos e
períodos, canais e horários. Skills: cobrança de parcela vencida e orientação de distrato.
Persona: resort fictício, sem citar o cliente real.

## Fora de escopo
- **Reserva, calendário de uso, check-in, hospedagem, intercâmbio.** Não existem no espelho
  — varredura por `reserva|utilizac|checkin|hosped|diaria|temporada|calendar` só achou
  parâmetro contratual, nenhum movimento. `idcontratointercambio` é 100% NULL; de RCI só
  existe a flag `RCI - FILIADO` em `contrato.tag`. Cotista que perguntar isso **deve** ouvir
  que o agente não sabe e receber um humano — é o Ato 1 pergunta 3 do roteiro, agora com uma
  limitação real em vez de encenada.
- **Taxa condominial.** Só 5 títulos `TXMANUT` no espelho inteiro; o empreendimento ainda
  está em ciclo de venda, não em operação madura.
- **Negociar desconto de inadimplência.** `perfilcobranca` tem a régua por faixa de atraso,
  mas o guardrail de preço permanece como está: agente não negocia valor, escala para humano.
  Decisão de negócio registrada, não limitação técnica.
- Conectar no banco real. Esta spec só reproduz a estrutura; a integração é outra sessão.

## Critérios de aceite
- `pnpm db:seed:erp` popula tudo; rodar 2x não duplica.
- `erp_ro` lê as 6 views e **não** lê tabela física nem escreve em nada (teste da 002 continua valendo).
- As 8 entradas do catálogo carregam, validam e executam com bind nomeado; `source: session`
  não aceita valor vindo do LLM.
- `v_titulo` não usa `datavencimento` cru como referência de atraso, e descarta datas fora
  da janela de sanidade — teste com linha semeada em ano absurdo.
- `v_cotista` nunca devolve nome ou CPF reais — teste que o campo é o pseudônimo.
- Turno de ponta a ponta: pergunta de saldo devolve valor do seed; pergunta de reserva
  admite não saber e escala.
- `pnpm lint && pnpm test && pnpm build` verdes.
