# 015 — Agente SDR para lead frio (qualificação, oferta e alçada de desconto)

## Objetivo
Hoje um número **sem vínculo** que chega perguntando preço cai num vazio. O classificador
pega `comprar_cota` e escala em `turno-handler.ts:405` **antes do grafo do agente** — o
trace do turno sai com `tools_expostas: null` e a resposta é o `TEXTO_INTERESSE_COMPRA`,
escrito para cotista: *"Que bom que você quer ampliar sua participação... posso ajudar com
o seu contrato atual"*. Ninguém pergunta quem é a pessoa, ninguém captura o lead e ninguém
responde "quanto custa".

Esta spec entrega o **SDR**: a raia sem vínculo passa a qualificar o lead, apresentar o que
existe disponível, fazer oferta dentro de uma **alçada de 3%** e agendar com o comercial —
escalando para validação humana acima da alçada.

O desenho segue a 014: o LLM **nunca faz conta com dinheiro**. A máquina de estados calcula
a oferta no servidor, persiste antes de enviar, e o LLM só interpreta a resposta do lead e
redige sobre números que já vieram prontos.

## Escopo

### `packages/sdr` — agente SDR (domínio puro, sem banco)
- Máquina de estados (`qualificacao → apresentacao → oferta → agendamento → encerrado`),
  parser determinístico das respostas e `interpretarResposta` (chamada curta ao LLM com
  saída JSON validada por Zod) só quando o parser não resolve — mesmo contrato de
  `packages/cobranca`.
- **Alçada em basis points, aritmética inteira em centavos**:
  `piso = floor(tabela * (10000 - SDR_DESCONTO_MAX_BPS) / 10000)`. Sem float.
  A base dos 3% é o **valor de tabela da cota a ser comprada**
  (`v_cota_disponivel.valor_tabela_centavos`) — não o total do contrato nem a entrada.
- **Pontos de preço discretos**: a oferta é `tabela` **ou** `piso` — nunca um valor
  intermediário. O `guardrailPreco` casa por conjunto exato (não por intervalo), então
  valor intermediário escalaria; e comercialmente evita fatiar desconto em salame.
- `referenciaProposta(lead, cota)` determinística — idempotência da proposta.

### Banco (`apps/server`, migração 0015)
- **`lead`**: `wa_id` (unique), `nome`, `origem`, `perfil` (jsonb da qualificação),
  `status` (`novo|qualificando|qualificado|proposta|agendado|perdido`), `traceId`.
  Lead **não existe no ERP** até virar contrato — mora no banco `app`.
- **`fluxo_sdr`**: 1 ativo por conversa, com expiração (espelha `fluxo_cobranca`).
- **`proposta_sdr`**: `leadId`, `cotaId`, `valor_tabela_centavos`,
  `valor_minimo_centavos`, `valor_ofertado_centavos`, `desconto_bps`, `status`
  (`rascunho|ofertada|aguardando_aprovacao|aceita|recusada|expirada`). **Gravada antes de
  ser enviada** — é a trilha de auditoria e a fonte de verdade da alçada.

### ERP mock (`infra/erp-mock`) — **feito**
- Tabela **`tabelapreco`** (`idgrupocota` × `idmodelocota` → `valorcentavos`): 24
  combinações, base do tier × fator do modelo, aritmética inteira em centavos.
  De `OURO SPECIAL` bienal (R$ 23.400) a `DIAMANTE PREMIUM` anual 3 períodos (R$ 285.600).
- View **`v_cota_disponivel`**: as 44 cotas `statuscota = 'DISPONIVEL'`, com bloco, andar,
  UH, capacidade, tier, modelo, períodos e `valor_tabela_centavos`. É a **única view que
  não é grão-contrato** — não recebe `contrato_id` e por isso é legível por sessão sem
  vínculo. `GRANT SELECT` para `erp_ro` em `03-grants.sql`.

### Catálogo (`catalog/comercial/`)
- `estoque_disponivel.yaml` — filtra por tier/capacidade/períodos. `price_source: false`.
- `condicoes_cota.yaml` — **`price_source: true`**, devolve `valor_tabela_centavos` **e**
  `valor_minimo_centavos` (o piso já calculado no servidor). É esta linha que autoriza a
  oferta perante o guardrail.
- Ambas **sem `contrato_id`** — são as primeiras entradas do catálogo que não são
  grão-contrato.

### Server
- `comprar_cota` **em conversa sem vínculo** inicia o fluxo SDR em vez de escalar (mesma
  forma que `pagar → fluxo` em `turno-handler.ts:400`). Com vínculo, o comportamento
  atual é preservado: continua escalando `interesse_compra` para o comercial.
- `buildToolSpecs`: o portão `temVinculo === false ⇒ []` (`tools.ts:38`) passa a filtrar
  **por escopo da tool**, não por vínculo. Entrada com param `source: session` derivado do
  contrato exige vínculo; entrada sem ele (estoque, condições) é liberada para o lead.
- Acima da alçada → ticket `aguardando_humano` com trigger **`desconto_acima_alcada`**,
  com a `proposta_sdr` anexada para o humano validar o número proposto.
- Env: `SDR_DESCONTO_MAX_BPS` (default `300`), `SDR_FLUXO_EXPIRA_MIN`,
  `SDR_MAX_PROPOSTAS_DIA`. `client.yaml`: `modulos.sdr`, `personaSdr`.

### Console
- Página **Leads**: lista com status, perfil da qualificação, propostas e histórico;
  aprovar/recusar proposta acima da alçada.

## Fora de escopo
- **Alterar `packages/guardrails/src/preco.ts`.** O guardrail já implementa a alçada sem
  uma linha nova — ver Premissas.
- SDR para **cotista com vínculo** (upgrade/cross-sell): continua escalando como hoje.
- **Prospecção ativa** (iniciar conversa com número frio): exige template aprovado da Meta
  e tem implicação de compliance própria; a 013 cobre o disparo, a amarração fica para
  outra spec.
- Reserva/bloqueio de cota, contrato, assinatura, pagamento da entrada (a 014 cobra
  parcelas de contrato existente; lead não tem contrato).
- Negociação de prazo, condição de parcelamento fora da tabela, permuta.

## Premissas
- **A alçada é emergente, não programada.** Verificado empiricamente contra o
  `guardrailPreco` atual (sem alterá-lo), com a tool `price_source` devolvendo tabela +
  piso e os valores reais do seed — cota `C501-133` (DIAMANTE PREMIUM, 2 períodos):
  tabela `20825000`, piso `20200250`.

  | Draft | Veredito |
  |---|---|
  | `A C501-133 está R$ 208.250,00.` (tabela) | **passa** |
  | `Fecho em R$ 202.002,50 à vista.` (piso, −3,0%) | **passa** |
  | `Fecho em R$ 205.126,00 à vista.` (−1,5%, dentro da faixa) | escala |
  | `Fecho em R$ 199.920,00 à vista.` (−4,0%) | escala |
  | `Consigo 3% de desconto pra você.` | escala (`RE_CONDICAO_ESPECIAL`) |

  Fora dos dois pontos autorizados escala **sozinho**, porque o valor não está no conjunto
  rastreável do turno. A alçada não é programada — é a invariante existente operando.
- **O SDR fala em valor, nunca em percentual.** Dizer o número em vez da concessão mantém
  o guardrail intacto para a raia do cotista — e é melhor prática comercial (ancorar no
  preço, não no desconto). Os templates do fluxo **não podem conter** o vocabulário do
  `RE_CONDICAO_ESPECIAL`: `desconto`, `abatimento`, `cortesia`, `por conta da casa`,
  `preço especial`, `condição especial`, `baixar o preço` e **`faço por`** — este último
  pega desprevenido, porque é fraseado comercial neutro que o guardrail trata como oferta
  de condição. Use "fecho em R$ X" / "está R$ X". `RE_PERCENTUAL` barra qualquer `%`.
- **Lacuna conhecida — percentual por extenso não é barrado.** `RE_PERCENTUAL` exige
  dígito, então "aplico **três por cento**" passa; e como `aplicar` não está no
  `RE_CONDICAO_ESPECIAL`, não há segunda rede. Passa **em qualquer contexto**, inclusive
  sem nenhuma tool no turno. Na raia do cotista o classificador de intenção
  (`negociar_preco`) pega antes; na raia do SDR, que negocia, é exposição real. Mitigado
  pelo desenho — as mensagens de oferta são renderizadas pela máquina de estados, não pelo
  LLM — mas a fase de qualificação é texto livre. Travado em teste
  (`015: alçada > LACUNA: percentual por extenso NÃO é barrado`); **decisão pendente** se
  corrige o `RE_PERCENTUAL` (afeta também a raia do cotista) ou se fica só a mitigação.
- As duas raias são **disjuntas por construção** (`vinculo == null`): o SDR não consegue
  regredir o fluxo do cotista.
- Mensagens de valor são determinísticas (calculadas no servidor), não rascunhos do LLM.
- LGPD: o lead iniciou o contato; a captação se apoia nisso e no interesse pré-contratual.
  Sem CPF na qualificação — só o necessário para o comercial retornar.
- Os preços do `erp_mock` são fictícios e plausíveis para multipropriedade brasileira,
  gerados por `base do tier × fator do modelo`. Quando o espelho real (`bali-vps`) estiver
  acessível, só a carga da `tabelapreco` muda — o formato da view e a alçada não.

## Critérios de aceite
- Número **sem vínculo** dizendo "quero comprar uma cota, quanto custa?" entra no fluxo
  SDR: grava `lead`, qualifica (perfil), apresenta o disponível e chega à oferta — o trace
  do turno sai com `tools_expostas` não-nulo (hoje é `null`).
- Número **com vínculo** dizendo o mesmo continua escalando `interesse_compra` — sem
  regressão da raia do cotista.
- Oferta na tabela e oferta no piso (−3%) passam o `guardrailPreco` **sem alterá-lo**;
  qualquer valor abaixo do piso escala com `desconto_acima_alcada` e cria ticket com a
  `proposta_sdr` anexada.
- Nenhum draft do SDR contém `%` nem a palavra "desconto" (teste de guardrail dedicado).
- `proposta_sdr` é gravada **antes** do envio; pedir a mesma oferta duas vezes não cria
  segunda proposta.
- Sem `modulos.sdr`, a raia sem vínculo se comporta exatamente como hoje.
- Lead sem vínculo **não** enxerga nenhuma tool grão-contrato (`minha_cota`,
  `titulos_atraso`, `iniciar_pagamento`…).
- Duas respostas não entendidas encerram o fluxo; "não tenho interesse" marca `perdido`.
- `pnpm lint && pnpm test && pnpm build` verdes.
