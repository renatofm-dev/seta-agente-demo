# API do TS Explorer (TSE) — o contrato e como rodar contra ele

Guia da segunda superfície de integração com o ERP (a primeira é o SQL das 7 views canônicas —
ver [dev/05](dev/05-dados-e-integracoes.md)). A decisão de adotá-la está no
[ADR 0002](adr/0002-integracao-erp-por-api.md); as specs são a
[035](../specs/035-tse-api-simulada.md) a [041](../specs/041-tse-real-e-fim-da-conciliacao.md).

**Não temos ambiente de homologação do fornecedor.** Tudo aqui roda contra o simulador
`apps/tse-sim`, que responde no mesmo contrato. Quando houver um ambiente real, só muda
`TSE_BASE_URL` (spec 041).

> **Estado (035 entregue):** o simulador responde **30 das 89** rotas da coleção — `/token`,
> `PainelDoCliente/*` de leitura, `utilizacaocontrato/obtercontratos`, `cadastros/GetPessoa*`,
> os 17 `Lookup/*` e as três escritas de `financeiro/*`. O placar do que falta está em
> `apps/tse-sim/test/pendentes.ts`, e o teste de contrato garante que a lista **só encolhe**.
> As 59 restantes têm dono: reserva na [038](../specs/038-reserva-utilizacao.md), lead e venda
> na [039](../specs/039-sdr-escreve-no-erp.md), 2ª via na
> [040](../specs/040-segunda-via-pdf.md); `OperadorSistema/*` e `Relatorios/*` não têm.

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

Como conferir que a sanitização pegou tudo: **todo CPF no `contrato/` começa com `000`** e tem DV
válido — é um CPF gerado, e o prefixo prova a origem. `grep -rE '[0-9]{11}' contrato` não serve
como teste (casa com as substituições e com pedaços de código de barras); quem faz essa conferência
é `contrato.test.ts`, que reprova qualquer CPF sem o prefixo, qualquer `timesharesolucoes` e
qualquer `Bearer` que não seja `SCRUBBED`.

**O PDF da 2ª via é a exceção que não vai para o repo.** `SegundaViaBoleto` devolve um boleto
real — cedente, CPF, código de barras de gente de verdade — e nenhuma regra de sanitização alcança
bytes de PDF. A fixture guarda `contentType`, `bodyBytes` e o `sha256` do exemplo, que é a FORMA de
que a [040](../specs/040-segunda-via-pdf.md) precisa; o documento fica fora.

A **040** (entregue em 17/09/2026) fez exatamente isso: o dublê **gera** um boleto sintético de uma
página, com tarja de *documento simulado*, em `apps/tse-sim/src/boleto-pdf.ts`. Ela também escolheu
o 404 para os casos sem arquivo, que a coleção não exemplifica — divergência consciente, registrada
em `divergencias.integration.test.ts` e a confirmar com o fornecedor junto com a D10.

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

## 4b. A baixa de pagamento: o buraco que a coleção tem

**Não existe endpoint de baixa para PIX ou boleto.** `financeiro/TransacaoEletronica` é o único
caminho de baixa das 90 rotas, e o corpo dele é inteiramente de cartão:

```
IdContaFinanceira, Valor, QuatroPrimeirosDigitosCartao,
QuatroUltimosDigitosCartao, CodigoAutorizacao, QuantidadeParcelas, NomePessoa
```

Varredura em todos os corpos de request da coleção atrás de `DataPagamento`, `DataRecebimento`,
`DataLiquidacao`, baixa ou quitação: **nenhum campo**. O `PUT ContaFinanceira` também não tem — ele
altera valor, vencimento e meio, nunca registra recebimento.

A plataforma cobra por PIX e boleto (042/043). **Premissa adotada na 036**, enquanto o fornecedor
não responde (pergunta 1 do §6):

> usar `TransacaoEletronica` com os campos de cartão **nulos** e o id da cobrança no PSP em
> `CodigoAutorizacao`.

Ela não inventa endpoint nem campo — usa só o que a coleção tem —, dá ao financeiro do cliente o
link com o extrato do gateway, e é o que o read-back usa para reconhecer a própria baixa. Se a
resposta vier diferente, muda `packages/erp-api-tse/src/cliente.ts:registrarPagamento` e nada mais.

## 5. Respostas que não são JSON

Três escritas devolvem **prosa**, e HTTP 200 **não é prova de sucesso**:

| Endpoint | Resposta |
|---|---|
| `financeiro/TransacaoEletronica` | `"Transação inserida com sucesso, sob id: 1"` |
| `vendats/SetVenda/0` | `"IdContrato: 285"` |
| `utilizacaocontrato/ConfirmarUtilizacaoContrato/{id}` | `"Utilização confirmada com sucesso!"` |

O adapter extrai o id por regex estrita e lança `ErpBusinessError` quando não casa.

E `PainelDoCliente/SegundaViaBoleto/{id}` devolve **PDF binário**, não JSON.

Há ainda uma quarta: `Lookup/ConsultarNumeroVersao` devolve `"17.8.24.2003"` — uma **string JSON**
com `content-type: application/json`. Parece bobagem e não é: quem devolve string por engano num
framework que serializa string como `text/plain` quebra o adapter no ponto em que ele menos espera.
O simulador força o content-type nas quatro.

## 6. A pergunta aberta ao fornecedor

**`PainelDoCliente/*` resolve o escopo pelo dono do token, ou aceita `idContrato` de qualquer
cotista?**

No exemplo salvo, o token é de `TSE.INTEGRACAO` (`userId: 305`) e `MeusContratos` devolve o
contrato cujo cessionário é "INTEGRAÇÃO TSE". Se o painel é por token, **o caminho de leitura
financeira por API não serve**: o nosso agente atende N cotistas com uma credencial de integração.

Enquanto a resposta não vem, o simulador exercita os dois comportamentos:
`TSE_SIM_PAINEL_ESCOPO=token|qualquer` (default `qualquer`), e
`apps/tse-sim/test/divergencias.integration.test.ts` prova os dois lado a lado. O teste também
registra a saída de emergência: **`utilizacaocontrato/obtercontratos?cpf=` ignora o escopo** —
se a D10 vier ruim, é por ali que o agente ainda acha o contrato certo. Plano B mapeado:
`Relatorios/ObterJsonDadosRelatorioComParametros`. Registrado como **D10** no
[roadmap](roadmap.md) e como decisão externa na
[spec 041](../specs/041-tse-real-e-fim-da-conciliacao.md).

**Nenhuma destas respostas bloqueia a demo** — ela roda contra o simulador da 035, que é nosso.
Elas bloqueiam a [041](../specs/041-tse-real-e-fim-da-conciliacao.md), que é o piloto. Cada uma
virou **premissa escrita e isolada**, para que a resposta custe uma função e não um redesenho:

| Pergunta | Premissa em vigor | Onde muda |
|---|---|---|
| baixa de PIX/boleto | `TransacaoEletronica` com cartão nulo + id do PSP na autorização (§4b) | `cliente.ts:registrarPagamento` |
| como é uma falha | 200 só é sucesso se a prosa casar com a regex; o resto é `ErpBusinessError` → ticket | `cliente.ts` (`ID_DA_PROSA`) |
| idempotência | assumir que **não** é; read-back antes de repetir, e `erp_escrita.chave` como PK | `erp/baixa.ts` |
| escopo do painel (D10) | demo com `escopo=qualquer`; o adapter acha o contrato por `obtercontratos?cpf=` | `TSE_SIM_PAINEL_ESCOPO` |

A terceira nem era pergunta deles: a garantia de não baixar duas vezes é nossa de qualquer jeito.

**Pergunta pronta para enviar ao fornecedor** (copiar e colar):

> Estamos integrando um assistente de atendimento à API do TS Explorer. Ele atende vários cotistas
> de um mesmo cliente com **uma única credencial de integração**, e registra pagamentos recebidos
> por um gateway externo (PIX e boleto).
>
> 1. **Baixa de pagamento que não é cartão.** O único endpoint de baixa que encontramos é
>    `POST /api/financeiro/TransacaoEletronica`, e o corpo dele é de cartão
>    (`QuatroPrimeirosDigitosCartao`, `CodigoAutorizacao`, `QuantidadeParcelas`). Como registramos
>    o pagamento de uma parcela recebida por **PIX ou boleto**? Existe outro endpoint, ou usamos o
>    mesmo colocando o identificador da transação do gateway em `CodigoAutorizacao`? Se for o
>    mesmo, qual `IdMeioPagamento` devemos informar?
> 2. **Escopo do `PainelDoCliente`.** `MeusContratos`, `FinanceiroContrato`, `MeusBoletos` e
>    `SegundaViaBoleto` resolvem o escopo pelo **operador dono do token**, ou aceitam o
>    `idContrato` de qualquer cotista da empresa desde que o operador tenha permissão? Se for pelo
>    dono do token, qual o caminho recomendado para ler o financeiro de N cotistas?
> 3. **Como é uma falha.** Os 89 exemplos da coleção são todos HTTP 200, e três escritas respondem
>    com uma frase. Quando a operação **falha** — parcela inexistente, valor divergente, parcela já
>    baixada — a API devolve status diferente de 200, ou 200 com mensagem de erro no corpo? Existe
>    código de erro estruturado?
> 4. **Idempotência.** `POST /api/financeiro/TransacaoEletronica` é idempotente? Se reenviarmos a
>    mesma transação (mesma `IdContaFinanceira`, mesmo `CodigoAutorizacao`) por um retry de rede,
>    ela é registrada duas vezes? Qual o tamanho máximo de `CodigoAutorizacao`?
> 5. **Homologação.** Existe ambiente de homologação com credenciais para testes automatizados?
>
> *(Obs.: na coleção, `/token` e `SimularUtilizacaoContrato` aparecem como `GET` com corpo, o que a
> maioria dos clientes HTTP recusa. Assumimos `POST`; se estiver errado, nos avisem.)*

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

Do **simulador** (035, já valem):

| Var | Para que |
|---|---|
| `TSE_SIM_PORT` | porta do simulador (3010) |
| `TSE_SIM_DATABASE_URL` | papel `tse_sim` no banco `erp_mock` — **não** o `erp_ro`, que é só-leitura, nem o admin |
| `TSE_SIM_DB_PASSWORD` | senha desse papel, aplicada por `pnpm db:seed:erp` (o `04-sim-role.sql` a lê por bind). Em produção o boot recusa a senha de dev |
| `TSE_SIM_USERS` | `login:senha:idPessoa`, separados por vírgula — o `idPessoa` é quem o token representa no painel |
| `TSE_SIM_PAINEL_ESCOPO` | `token` ou `qualquer` (ver §6) |
| `TSE_SIM_LATENCIA_MS` / `TSE_SIM_FALHA_BPS` | caos controlado: atraso fixo e falhas 500 em basis points, para exercitar timeout e retry do adapter |

Do **produto** (036 entregue; `ERP_LEITURA` é da 037, ainda não existe):

| Var | Para que |
|---|---|
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
