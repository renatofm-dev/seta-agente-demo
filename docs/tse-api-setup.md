# API do TS Explorer (TSE) — o contrato e como rodar contra ele

Guia da segunda superfície de integração com o ERP (a primeira é o SQL das 7 views canônicas —
ver [dev/05](dev/05-dados-e-integracoes.md)). A decisão de adotá-la está no
[ADR 0002](adr/0002-integracao-erp-por-api.md); as specs são a
[035](../specs/035-tse-api-simulada.md) a [041](../specs/041-tse-real-e-fim-da-conciliacao.md).

**Não temos ambiente de homologação do fornecedor.** Tudo aqui roda contra o simulador
`apps/tse-sim`, que responde no mesmo contrato. Quando houver um ambiente real, só muda
`TSE_BASE_URL` (spec 041).

## 1. A fonte: a coleção Postman

O fornecedor entregou uma coleção com **90 requests em 10 pastas** e **89 exemplos de resposta
salvos** (≈288 KB de corpo). Ela é o único contrato que temos, e por isso vive no repo em
`apps/tse-sim/contrato/tse-api.collection.json` — **sanitizada**: os exemplos originais trazem
e-mails de funcionários do fornecedor, CPFs e um `access_token` de 2021. O `sha256` do original
fica em `tse-api.collection.sha256` para provar procedência; o original, fora do git.

`pnpm tse:fixtures` regenera `contrato/fixtures/*.json` e `contrato/indice.json` a partir dela.
Esses arquivos são o oráculo dos testes de contrato **dos dois lados**: o simulador prova que
responde como o TSE, e o adapter prova que entende o que o TSE responde.

> **Armadilha:** dois bodies da coleção (`CriarUtilizacaoContrato`, `AdicionarHospede`) têm
> comentários `//` dentro do JSON. `JSON.parse` quebra — o extrator remove comentários antes.

## 2. Autenticação

```
POST {{connection}}/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=<usuário>&password=<senha>
```

```json
{ "access_token": "k9M6…", "token_type": "bearer", "expires_in": 86399,
  "userName": "TSE.INTEGRACAO", "userId": "305" }
```

Demais rotas: `Authorization: Bearer <access_token>`.

> **A coleção marca `/token` como `GET` com body.** `fetch` do Node lança
> `Request with GET/HEAD method cannot have body`. O endpoint OWIN do ASP.NET aceita `POST` (é o
> padrão), então o adapter usa POST e o simulador registra as duas rotas. O mesmo vale para
> `utilizacaocontrato/SimularUtilizacaoContrato`.

O token vale ~24 h. O adapter faz cache com renovação a T−5 min, **uma promessa de refresh em
voo** (para não mandar N logins simultâneos ao TSE) e, em `401`, reautentica e repete a chamada
uma única vez.

## 3. O que cada jornada usa

| Jornada | Endpoints | Spec |
|---|---|---|
| **Identificar o cotista** | `utilizacaocontrato/obtercontratos?cpf=` · `cadastros/GetPessoaCpf/{cpf}` | 035 |
| **Financeiro / cobrança** | `PainelDoCliente/FinanceiroContrato?idContrato=&paginaAtual=` · `MeusBoletos` · `MeusContratos` · `ObterTaxasDPNU/{id}` | 035, 037 |
| **Baixa de pagamento** | `financeiro/TransacaoEletronica` · `financeiro/ContaFinanceira` (POST/PUT) | 036 |
| **Reserva / utilização** | `PainelDoCliente/{HoteisDisponiveisUso, TiposUnidadeHoteleira, SimularUtilizacaoContrato, CriarSolicitacaoReserva, MinhasUtilizacoesContrato}` · `utilizacaocontrato/{ObterHoteis, ObterTipos*, SimularUtilizacaoContrato, CriarUtilizacaoContrato, AdicionarHospede, AdicionarTaxaManutencao, ConfirmarUtilizacaoContrato, CancelarUtilizacaoContrato, ObterTotalReceberPorTipo}` | 038 |
| **SDR: lead e venda** | `recepcaots/{setcasal, GetCasal}` · `vendats/SetVenda` · `cadastros/SetPessoa` · `Lookup/{Produtos, CotasByProduto, OrigensVenda, TiposRelacionamento}` | 039 |
| **2ª via em PDF** | `PainelDoCliente/SegundaViaBoleto/{idContaFinanceira}` | 040 |
| **Não usamos** | `OperadorSistema/*` (21 rotas), `Relatorios/*` (3) | — |

## 4. Como o TSE mapeia no nosso domínio

| Nosso | TSE | Cuidado |
|---|---|---|
| `contrato_id` da sessão | `IdContrato` | **Não** é o `NumeroContrato` — no TSE são campos diferentes (no exemplo, `IdContrato: 273` e `NumeroContrato: "1"`). Trocar devolve o financeiro de outro cotista |
| `titulo_id` (`v_titulo.id`) | `Identificador` / `IdContaFinanceira` | `infra/erp-mock/02-views.sql:83` já mapeia `idcontafinanceira::text AS id` |
| `valor_centavos` | `ValorReceber` | **Não** `ValorParcela`, nem `ValorParcelaComCorrecaoMonetaria`, nem `ValorPrevistoReceberLiquido`. `v_titulo` usa `valorreceber` |
| `vencimento` | `DataVencimentoRecorrencia` ⟶ `DataVencimento` | Primeiro não-nulo (a origem reescreve `DataVencimento` quando a recorrente é paga) |
| `status` (`pago\|vencido\|aberto`) | `Pago`, `Vencido`, `QtdDiasVencido` | O TSE já entrega derivado — não recalcular |
| datas | `"2021-03-21T00:00:00-03:00"` | **Fatiar a string** (`.slice(0,10)`); passar por `Date` + `toISOString()` desloca o dia pelo offset, e um dia de erro troca `vencido` por `aberto` |
| dinheiro | decimal (`66.68`) | `Math.round(reais * 100)` — `66.68 * 100 = 6668.000000000001` |

## 5. Respostas que não são JSON

Três escritas devolvem **prosa**, e HTTP 200 **não é prova de sucesso**:

| Endpoint | Resposta |
|---|---|
| `financeiro/TransacaoEletronica` | `"Transação inserida com sucesso, sob id: 1"` |
| `vendats/SetVenda/0` | `"IdContrato: 285"` |
| `utilizacaocontrato/ConfirmarUtilizacaoContrato/{id}` | `"Utilização confirmada com sucesso!"` |

O adapter extrai o id por regex estrita e lança `ErpBusinessError` quando não casa.

E `PainelDoCliente/SegundaViaBoleto/{id}` devolve **PDF binário**, não JSON.

## 6. A pergunta aberta ao fornecedor

**`PainelDoCliente/*` resolve o escopo pelo dono do token, ou aceita `idContrato` de qualquer
cotista?**

No exemplo salvo, o token é de `TSE.INTEGRACAO` (`userId: 305`) e `MeusContratos` devolve o
contrato cujo cessionário é "INTEGRAÇÃO TSE". Se o painel é por token, **o caminho de leitura
financeira por API não serve**: o nosso agente atende N cotistas com uma credencial de integração.

Enquanto a resposta não vem, o simulador exercita os dois comportamentos:
`TSE_SIM_PAINEL_ESCOPO=token|qualquer`. Plano B mapeado:
`Relatorios/ObterJsonDadosRelatorioComParametros`. Registrado como **D10** no
[roadmap](roadmap.md) e como decisão externa na
[spec 041](../specs/041-tse-real-e-fim-da-conciliacao.md).

**Pergunta pronta para enviar ao fornecedor** (copiar e colar):

> Estamos integrando um assistente de atendimento à API do TS Explorer, usando **uma única
> credencial de integração** para atender vários cotistas de um mesmo cliente.
>
> 1. Os endpoints de `PainelDoCliente` (`MeusContratos`, `FinanceiroContrato`, `MeusBoletos`,
>    `SegundaViaBoleto`) resolvem o escopo pelo **operador dono do token**, ou aceitam o
>    `idContrato` de qualquer cotista da empresa desde que o operador tenha permissão?
> 2. Se for pelo dono do token: qual é o caminho recomendado para um integrador ler o financeiro
>    de N cotistas? (`utilizacaocontrato/obtercontratos?cpf=` + algum endpoint de parcelas, ou
>    `Relatorios/ObterJsonDadosRelatorioComParametros`?)
> 3. `POST /api/financeiro/TransacaoEletronica` é **idempotente**? Se reenviarmos a mesma
>    transação (mesma `IdContaFinanceira`, mesmo `CodigoAutorizacao`), ela é registrada duas
>    vezes? Qual o tamanho máximo do campo `CodigoAutorizacao`?
> 4. `/token` e `utilizacaocontrato/SimularUtilizacaoContrato` aparecem na coleção como `GET` com
>    corpo. Confirmam que aceitam `POST`?
> 5. Existe **ambiente de homologação** com credenciais que possamos usar para testes
>    automatizados?

## 7. Rodar localmente

```bash
pnpm dev            # sobe Postgres, server :3001, console :3000 e o simulador :3010
pnpm demo:seed      # erp_mock + app + KB (idempotente)

# token
curl -s -X POST localhost:3010/token \
  -d 'grant_type=password&username=integracao&password=integracao'

# financeiro do contrato inadimplente do seed
curl -s 'localhost:3010/api/PainelDoCliente/FinanceiroContrato?idContrato=10002&paginaAtual=1' \
  -H "Authorization: Bearer $TOKEN" | jq '.ListaDados[0]'
```

Variáveis (todas em `.env.example`):

| Var | Para que |
|---|---|
| `TSE_SIM_PORT` | porta do simulador (3010) |
| `TSE_SIM_DATABASE_URL` | papel `tse_sim` no banco `erp_mock` — **não** o `erp_ro`, que é só-leitura, nem o admin |
| `TSE_SIM_USERS` | usuários aceitos pelo `/token` do simulador |
| `TSE_SIM_PAINEL_ESCOPO` | `token` ou `qualquer` (ver §6) |
| `TSE_BASE_URL` | o que o **produto** chama: `http://localhost:3010` em dev, `http://tse-sim:3010` no homelab (rede interna do compose, sem porta publicada), o TSE real na 041 |
| `TSE_USERNAME` / `TSE_PASSWORD` | credencial de operador — **poder de escrita financeira e de venda**; cofre e rotação, nunca `.env` commitado |
| `ERP_LEITURA` | `sql` (default) ou `api` |
| `ERP_CONCILIACAO` | `auto` (default), `on` ou `off` — ver [036](../specs/036-erp-escrita-baixa.md) |

## 8. O que o simulador **não** faz

Ele é fiel ao TSE e nada além disso: **nunca calcula regra de negócio nossa**. Status derivado,
conversão para centavos, agregados de inadimplência e piso de desconto são responsabilidade da
projeção do catálogo ou do adapter. Se o simulador começar a calcular, o adapter passa nos testes
contra ele e falha contra o TSE real — que é exatamente o erro que este simulador existe para
evitar.
