# 037 — O catálogo fala HTTP: `source: api` e as leituras financeiras pela API

> **Pré-spec** (rascunho de 14/09/2026): ainda não executada. Terceira fatia da frente
> **demo ponta a ponta**. Depende da **035** (simulador de pé) e da **036** (`ApiConnector`).
> Tamanho **G**.

## Objetivo
Hoje o catálogo só sabe SQL: `validate-sql.ts` recusa qualquer coisa que não seja um `SELECT` nas
7 views canônicas, e o `Executor` chama `DbConnector.execute`. Esta spec dá ao catálogo uma
segunda fonte — HTTP — sem tocar no que o agente vê. Ao final, as cinco entradas `financeiro.*`
leem do TSE pela API, e a mesma conversa responde igual, com a mesma tool, a mesma `description`,
o mesmo masking e a mesma auditoria.

**O catálogo híbrido é o estado final, não uma transição.** Cruzando as 7 views com os 90
endpoints da coleção:

| Entrada | Endpoint TSE | |
|---|---|---|
| `financeiro.*` (5) | `PainelDoCliente/FinanceiroContrato` | ✅ cobre inclusive os agregados |
| `contrato.meu_produto` | `PainelDoCliente/MeusContratos` | 🟡 sem `tier`/`periodos` |
| `contrato.minha_cota` | — | ❌ não existe |
| `contrato.status_cancelamento` | — | ❌ não existe |
| `atendimento.meu_chamado` | — | ❌ não existe |
| `comercial.*` | `Lookup/CotasByProduto` | 🟡 bloco/andar/UH/tier só concatenados em `IdentificadorUnicoCota` |

Por isso o discriminador é explícito e o par SQL/views continua vivo — inclusive para a
[018](018-espelho-real.md), que é o caminho do piloto Bali.

## Reaproveita
- `packages/query-catalog/src/executor.ts` — a interface `Executor`
  (`run(id, params, session) → RunResult`) já é a costura certa: `buildToolSpecs` depende **só**
  dela. Resolução de params (`:78-129`), `applyMasking`, `gravar(sink, …)` e `RunResult` **não
  mudam**.
- `packages/query-catalog/src/validate-sql.ts` — é o **molde** do gêmeo para HTTP: validação
  estática no boot, allowlist fechada, bind ⇔ param nos dois sentidos. Não muda e não é chamado
  para `source: api`.
- `packages/query-catalog/src/{masking,tools}.ts` — **não mudam**. `exigeVinculo()` (`tools.ts:38`)
  olha `params[].source === 'session'` e o nome; `price_source`, `modules` e `temVinculo` seguem
  valendo igual.
- `packages/erp-api-tse` (036) — o `ApiConnector`.
- `apps/tse-sim/contrato/fixtures/` (035) — a projeção é testada **sobre as fixtures, sem rede**.
- `packages/payment-provider/src/tipos.ts:87` (`reaisParaCentavos`) e
  `apps/server/src/pagamentos/candidatos.ts:17-25` (`isoDia`).

## Escopo

### Discriminador `source: sql | api`, default `sql`
`z.discriminatedUnion('source', […])` em vez de XOR por presença de campo. Três razões: mensagem
de erro legível quando o loader agrega os erros de 11 arquivos (`CatalogLoadError`); `source` é
auditável a olho nu na primeira linha do YAML; e com default `sql` **os 11 YAMLs existentes não
mudam nem uma linha**.

### Arquivos
| Arquivo | Muda? | O quê |
|---|---|---|
| `src/schema.ts` | ✏️ | `source`, `EndpointSpecSchema`, `ProjecaoSchema`, `FiltroSchema`, `AgregadoSchema`; `CatalogEntrySchema` vira união discriminada. Move `KNOWN_SESSION_PARAMS`/`SESSION_PARAMS_DE_VINCULO` de `validate-sql.ts` (que deixa de ser caminho comum) **mantendo re-export** — senão quebra `tools.ts:6` e `index.ts:27` em silêncio |
| `src/validate-endpoint.ts` | ➕ | o gêmeo de segurança (abaixo) |
| `src/projecao.ts` | ➕ | `projetar(json, endpoint, limits) → {rows, truncated}`, **função pura** — é o coração do risco e tem que ser testável sem rede |
| `src/loader.ts` | ✏️ | ~6 linhas: `entry.source === 'sql' ? validateEntrySql : validateEntryEndpoint`. Ganha `loadCatalog(dir, {fontes})` para **derrubar o boot** se houver entrada `api` sem `ApiConnector` ligado |
| `src/executor.ts` | ✏️ | `CreateExecutorOptions` ganha `api?: ApiConnector`; o `try` de `:132-147` ganha um ramo. Tudo antes e depois igual |
| `src/index.ts` | ✏️ | exports |
| `package.json` | ⛔ | **nenhuma dependência nova** — `fetch` é nativo, `zod` e `yaml` já estão lá |

### `validate-endpoint.ts` — o equivalente do `CANONICAL_VIEWS`
Este é o ponto inegociável. Hoje a garantia "o catálogo só lê" vem de `validate-sql.ts:78-97`.
Sem um gêmeo, um YAML poderia declarar `method: POST, path: /api/financeiro/TransacaoEletronica` e
o catálogo viraria via de escrita — **com o LLM escolhendo os parâmetros**.

Regras, todas erro de boot e todas testadas:
1. `method ∈ GET | POST`, e `POST` **só** para paths na lista fechada `PATHS_LEITURA_POST` (os
   GET-com-body do TSE: `utilizacaocontrato/SimularUtilizacaoContrato`,
   `Relatorios/ObterJsonDadosRelatorioComParametros`).
2. **Allowlist de prefixos** `PATHS_CANONICOS`, gêmea de `CANONICAL_VIEWS`:
   `/api/PainelDoCliente/`, `/api/utilizacaocontrato/Obter`,
   `/api/utilizacaocontrato/obtercontratos`, `/api/cadastros/GetPessoa`, `/api/Lookup/`.
3. **`/api/financeiro/` e todo verbo de escrita (`Set*`, `Criar*`, `Adicionar*`, `Remover*`,
   `Confirmar*`, `Cancelar*`, `Alterar*`, `Efetuar*`) são proibidos no catálogo, sempre.**
4. Bind ⇔ param nos dois sentidos, como no SQL (`validate-sql.ts:44-50`).
5. Path sem interpolação (`${`), sem `?`, sem `//`.
6. `source: session` só com nomes de `KNOWN_SESSION_PARAMS`.
7. Toda coluna de `output.columns` é produzida por `projection` ou `summary`; todo `filter`/`sort`
   referencia coluna produzida; `masking` só sobre `output.columns`.
8. **Vocabulário de transformação fechado** — nada de expressão, nada de `eval`:
   `type ∈ string|int|centavos|date|bool`, `fn ∈ count|sum|min|max|dias_desde|desconto_bps`,
   `filter.op ∈ eq|neq|in|lt_hoje|gte_hoje|true|false`.

### Forma da entrada `api` (exemplo: `financeiro.titulos_atraso`)
O payload real de `FinanceiroContrato` traz no topo `TotalPaginas`, `QtdParcelasEmAtraso`,
`QtdParcelasPagas`, e por item `Identificador`, `TipoParcelaDescricao`, `NroParcela`,
`ValorReceber`, `DataVencimento`, `DataVencimentoRecorrencia`, `Pago`, `Vencido`,
`QtdDiasVencido` — os derivados que a view calcula já vêm prontos.

```yaml
source: api
endpoint:
  method: GET
  path: /api/PainelDoCliente/FinanceiroContrato
  query: { idContrato: contrato_id }     # valor = bind do param, nunca literal
  paginate: { param: paginaAtual, total_em: TotalPaginas, max_paginas: 5 }
  select: ListaDados                      # caminho até o array; "$" = objeto vira 1 linha
  projection:
    id:             { from: Identificador,        type: string }
    origem:         { from: TipoParcelaDescricao,  type: string,
                      map: { ENTRADA: entrada, SALDO: saldo }, default: saldo }
    valor_centavos: { from: ValorReceber,          type: centavos }
    vencimento:     { from: [DataVencimentoRecorrencia, DataVencimento], type: date }
    _pago:          { from: Pago,                  type: bool }
    _vencido:       { from: Vencido,               type: bool }
    _atraso_dias:   { from: QtdDiasVencido,        type: int }
  filter: [{ col: _pago, op: false }, { col: _vencido, op: true }]
  sort:   [{ by: vencimento, dir: asc }]
  summary:                                 # o JOIN com v_inadimplencia de hoje
    qtd_titulos_vencidos:   { fn: count }
    saldo_vencido_centavos: { fn: sum, of: valor_centavos }
    maior_atraso_dias:      { fn: max, of: _atraso_dias }
```

`description`, `params`, `limits`, `output.columns`, `tool` e `price_source` ficam **idênticos** —
é o contrato que o agente, os guardrails e `apps/server/src/pagamentos/candidatos.ts` consomem.
Colunas `_prefixadas` são internas e não saem em `output.columns`.

### Onde cada derivado passa a ser calculado
| Derivado (SQL hoje) | Onde passa a ser | Por quê |
|---|---|---|
| `status ∈ pago\|vencido\|aberto` | projeção (`Pago`/`Vencido` → `filter`) | a API já entrega; não é regra nossa |
| `coalesce(datavencimentorecorrencia, datavencimento)` | projeção, `from: [A, B]` = primeiro não-nulo | regra de 1 linha, auditável no YAML |
| `valor * 100` | projeção, `type: centavos` = `Math.round(reais*100)` | `66.68 * 100 = 6668.000000000001` |
| agregados de `v_inadimplencia` | projeção (`summary`), conferidos contra `QtdParcelasEmAtraso` num teste | o TSE já dá o total; usamos o nosso e validamos contra o dele |
| `valor_minimo_centavos` (piso do SDR) | **fica em SQL** | é política NOSSA (`desconto_max_bps`), não dado do ERP |
| parse de `IdentificadorUnicoCota` | **nem no YAML, nem no simulador** | se um dia precisar, vira leitura tipada no adapter exposta como `ToolSpec` pelo server |

**Regra geral:** o simulador nunca calcula regra de negócio nossa; o adapter normaliza transporte;
a projeção declarativa renomeia/converte/filtra/agrega com vocabulário fechado; TypeScript tipado
só quando a transformação não cabe no vocabulário.

### Chave de leitura
`ERP_LEITURA=sql|api`, lido no boot. Com `api`, as entradas `financeiro.*` usam o `ApiConnector`.
O boot loga a fonte por entrada.

## Fora de escopo
- `contrato.*`, `atendimento.*` e `comercial.*` — não têm equivalente na coleção (tabela acima).
- Paginação além de `max_paginas`.
- Escrita pelo catálogo — proibida por desenho, e é o que `validate-endpoint.ts` garante.
- Apagar `conciliacao.ts` (041).

## Premissas
- **`PainelDoCliente/*` pode resolver escopo pelo dono do token.** No exemplo salvo, o token é de
  `TSE.INTEGRACAO` e `MeusContratos` devolve o contrato *desse usuário* — e o nosso agente atende
  N cotistas com **uma** credencial. Se o fornecedor confirmar que é por token, esta spec muda de
  caminho (plano B mapeado: `Relatorios/ObterJsonDadosRelatorioComParametros`). Até lá, o
  simulador exercita os dois por `TSE_SIM_PAINEL_ESCOPO`. **Resolver antes de começar.**
- `ValorReceber` é o campo certo (é o que `v_titulo` usa), não `ValorParcela`,
  `ValorParcelaComCorrecaoMonetaria` ou `ValorPrevistoReceberLiquido`. Escolher errado muda o valor
  cobrado de um cliente real.
- Datas vêm como `"2021-03-21T00:00:00-03:00"`. `type: date` **fatia a string** (`.slice(0,10)`),
  nunca passa por `Date` — `toISOString()` desloca o dia conforme o offset, e um dia de erro num
  vencimento troca `vencido` por `aberto`.

## Critérios de aceite
- Com `ERP_LEITURA=api`, a conversa inteira do cotista 10002 responde **igual** à de `sql` — teste
  comparativo lado a lado sobre o mesmo seed, entrada por entrada.
- `truncated` é verdadeiro quando há mais páginas: contrato com 60 parcelas vencidas e
  `max_rows: 50` ⇒ 50 linhas e `truncated: true`. (Sem isso, `titulos_atraso` perde parcelas em
  silêncio e o agente afirma um saldo errado — com o guardrail de preço aprovando, porque o valor
  veio de tool.)
- Um YAML com `method: POST` em `/api/financeiro/…` **derruba o boot** com mensagem clara.
- Entrada `source: api` sem `ApiConnector` ligado **derruba o boot** — não pode aparecer como falha
  de query no turno do cliente, parecendo bug do ERP.
- As 11 entradas legadas carregam sem alteração; `pnpm lint && pnpm test && pnpm build` verdes.
- `projecao.test.ts` roda sobre as fixtures da 035, sem rede.

## O que dá para demonstrar ao final
"O mesmo agente, a mesma conversa, a mesma resposta — só que agora nenhuma query SQL sai daqui: o
trace do turno mostra a chamada HTTP ao TS Explorer."

## Decisões a resolver (registrar a escolha na descrição do PR)
- `ERP_LEITURA` global ou por entrada (`source` já é por entrada — talvez a env seja redundante).
- `max_paginas: 5` é suficiente para o contrato bulk de 583 parcelas do seed?
- `summary` repetido em cada linha (como o JOIN de hoje) ou numa linha-resumo separada.
