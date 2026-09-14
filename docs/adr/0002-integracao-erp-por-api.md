# ADR 0002 — Integração com o ERP também pela API HTTP do TSE

- **Status**: aceito (2026-09-14, decisão do Renato)
- **Specs**: 035 (simulador), 036 (escrita/baixa), 037 (catálogo por HTTP), 041 (TSE real)
- **Relaciona**: [ADR 0001](0001-asaas-como-psp.md) (a parte sobre a baixa no ERP), 
  [spec 018](../../specs/018-espelho-real.md) (espelho SQL do piloto)

## Contexto

Até aqui, "ERP" no projeto significava **uma coisa só**: um banco Postgres lido por um papel
somente-leitura através de 7 views canônicas (specs 002, 003, 012). Essa decisão foi certa e
continua certa — é o que a 018 vai fazer contra o espelho `bali_tse` do piloto.

Mas ela tem um limite estrutural: **o espelho não escreve, e não tem tudo**. Duas consequências
vinham sendo pagas em silêncio:

1. A baixa de pagamento é fingida. `apps/server/src/pagamentos/conciliacao.ts` é um decorator do
   `Executor` que reescreve as leituras `financeiro.*` a partir da nossa tabela `pagamento`. O
   comentário no topo do arquivo já antecipava o débito: *"Em produção o ERP recebe a baixa e esta
   camada desaparece"*. O ADR 0001 registrou a mesma coisa ao rejeitar "escrever a baixa no ERP
   mock" — corretamente, porque naquele momento a única superfície era SQL.
2. Reserva, calendário de uso e check-in **não existem** no espelho (levantado na 012 sobre as 36
   tabelas replicadas). Por isso a persona do agente diz que não sabe reservar — e o roteiro de
   demo usa isso como prova de honestidade.

Em 14/09/2026 recebemos a coleção Postman da **API HTTP do TS Explorer**: 90 endpoints, 89 com
exemplo de resposta salvo, autenticação OAuth2 `password`. Ela tem o que falta —
`financeiro/TransacaoEletronica` (baixa), `utilizacaocontrato/*` (reserva), `recepcaots/setcasal`
(lead), `vendats/SetVenda` (venda), `SegundaViaBoleto` (PDF) — e cobre as leituras financeiras.

## Decisão

Adotar a **API HTTP do TSE como segunda superfície de integração**, ao lado do SQL, atrás de dois
ports novos em `packages/erp-api-tse`:

- **`ApiConnector`** — leitura genérica, gêmeo de `DbConnector.execute`. O catálogo
  (`packages/query-catalog`) ganha um discriminador `source: sql | api` e passa a despachar por
  entrada. `Executor`, `ToolSpec`, masking, auditoria em `evento_query`, `price_source` e
  `temVinculo` **não mudam** — a costura já estava no lugar certo.
- **`ErpWriter`** — escrita **tipada**, nunca dirigida por YAML. Só o servidor a usa, sempre dentro
  de worker pg-boss, sempre depois de confirmação capturada por máquina de estados determinística,
  sempre sob chave de idempotência persistida (`erp_escrita`).

E construir um **simulador fiel** (`apps/tse-sim`) sobre o mesmo `erp_mock`, com testes de contrato
gerados dos 89 exemplos — porque não temos ambiente de homologação do fornecedor, e sem ele a
integração só seria testada apontando para a produção de um cliente.

### O que isto **não** revoga

- O papel SQL continua **somente-leitura**. A escrita não passa por ele; vai por HTTP, com
  credencial própria de operador. A fronteira das specs 002/003 fica de pé — o ADR 0001 rejeitou
  escrever *no banco*, e continua valendo.
- A spec 018 (espelho real por SQL) segue necessária: `contrato.minha_cota`,
  `contrato.status_cancelamento` e `atendimento.meu_chamado` **não têm endpoint na coleção**, e
  `comercial.*` só parcialmente. **O catálogo híbrido é o estado final, não uma transição.**
- `packages/agent` continua sem conhecer nenhum adapter — regra nova no `.dependency-cruiser.cjs`,
  provada por fixture em `tools/boundaries.spec.ts`.

## Alternativas consideradas

- **Só SQL, enriquecendo o mock.** Rápido, mas a demo continua fingindo a baixa e reserva continua
  impossível. Não atende o pedido de "atendimento de ponta a ponta".
- **Só API, aposentando as views.** Não é possível: três entradas do catálogo não têm endpoint
  equivalente, e a `IdentificadorUnicoCota` do estoque comercial vem como string composta
  (`"TORRE 1-TORRE 01-01-101A-DIAMANTE-A"`), que exigiria parse fora do vocabulário declarativo do
  catálogo.
- **Escrita pelo catálogo (YAML declarando `POST`).** Rejeitada por segurança: colocaria o LLM
  escolhendo parâmetros de escrita financeira. `validate-endpoint.ts` **proíbe** `/api/financeiro/`
  e todo verbo de escrita no catálogo, como `validate-sql.ts` proíbe tudo que não seja `SELECT` nas
  7 views.
- **Traduzir SQL→HTTP num decorator do `DbConnector`.** Rejeitada de saída: exigiria interpretar
  SQL em runtime — o oposto de `validate-sql.ts`, que é estático justamente para não interpretar
  nada em runtime.

## Consequências

- **Positivas.** A baixa passa a ser real e verificável no ERP; a conciliação vira compensação
  apenas do que está em voo e depois some; reserva, lead e venda passam a existir; e a integração
  ganha um simulador que mantém o CI verde sem depender de terceiro.
- **Negativas / dívidas assumidas.** Duas superfícies de integração para manter; uma credencial de
  operador com poder de escrita financeira e de venda (cofre, rotação, gitleaks — 022/026); e uma
  premissa ainda aberta: **`PainelDoCliente/*` pode resolver escopo pelo dono do token**, e o nosso
  agente atende N cotistas com uma credencial. Se o fornecedor confirmar que é por token, o caminho
  de leitura financeira por API muda (plano B: `Relatorios/ObterJsonDadosRelatorioComParametros`).
  Está registrado como decisão externa na spec 041.
- **Nenhuma dependência nova.** Fastify, Zod e `pg` já estão no repo; o cliente HTTP usa `fetch`
  nativo, como o adapter do Asaas. A stack travada do `CLAUDE.md` fica intacta.
