# 036 — Port de escrita no ERP (`ErpWriter`) e baixa real do pagamento

> **Pré-spec** (rascunho de 14/09/2026): ainda não executada. Segunda fatia da frente
> **demo ponta a ponta**. Depende da **035** — mas só das fixtures (`apps/tse-sim/contrato/`), não
> do simulador pronto. Tamanho **G**. Trilha B.

## Objetivo
`apps/server/src/pagamentos/conciliacao.ts` existe porque o ERP é read-only, e diz isso no próprio
comentário: *"Em produção o ERP recebe a baixa e esta camada desaparece"*. Hoje o cotista paga, e
a plataforma **finge** que o ERP sabe: um decorator do `Executor` reescreve as leituras
`financeiro.*` a partir da tabela `pagamento`. Esta spec troca a ficção pelo fato — a baixa é
gravada no TSE por `POST /api/financeiro/TransacaoEletronica`, e a conciliação passa a compensar
**apenas o que ainda está em voo**.

É a fatia que faz "ponta a ponta" deixar de ser figura de linguagem: como a escrita vai pela API e
a leitura continua por SQL **sobre a mesma base**, a baixa aparece em `v_titulo.status = 'pago'`
na hora — sem depender da migração do catálogo (037).

## Reaproveita
- `packages/payment-provider/src/erros.ts` — o molde literal dos erros tipados, incluindo a crítica
  da issue #48 no comentário do arquivo ("nunca colapsar em `Error` genérico").
- `packages/payment-provider/src/asaas.ts` — `fetch` sem SDK, `AbortSignal.timeout` (`:120`),
  header próprio, User-Agent obrigatório. E `tipos.ts:87` (`reaisParaCentavos`): dinheiro nunca
  em float.
- `apps/server/src/pagamentos/eventos.ts` — `registrarEventoPsp` (`:60-70`) é o padrão
  **insert → `boss.send` depois do commit**; `marcarPaga` (`:148-196`) e o
  `onConflictDoNothing({target:[cobrancaId, tituloId]})` (`:183`).
- `apps/server/src/boss.ts:29-33` — `retryLimit`/`retryBackoff` de `FILA_COBRANCA_EMITIR`.
- `apps/server/src/pagamentos/escalar.ts` — baixa que falha vira ticket, não silêncio.
- `apps/server/src/env.ts:6-14` — `DEFAULTS_DE_DEV`/`SENHAS_DE_DEV`: o boot recusa segredo de
  exemplo em produção (P-28/P-31).
- `apps/tse-sim/contrato/indice.json` + fixtures (035) — é contra elas que os Zod de saída são
  testados, **sem rede**.

## Escopo

### `packages/erp-api-tse` (pacote novo)
Nome com o fornecedor no fim, como `payment-provider` guarda `asaas.ts` dentro. Duas interfaces,
um cliente, um fake.

```ts
interface ApiConnector {                     // leitura genérica — gêmeo de DbConnector.execute
  readonly fornecedor: 'tse';
  request(r: { method: 'GET'|'POST'; path: string;
               query?: Record<string, Scalar>; body?: unknown },
          o: { timeoutMs?: number }): Promise<{ status: number; json: unknown; latencyMs: number }>;
  health(): Promise<{ ok: boolean; latencyMs: number }>;
}

interface ErpWriter {                        // escrita TIPADA, nunca dirigida por YAML
  registrarPagamento(i: RegistrarPagamentoInput): Promise<{ transacaoId: string }>;
  lerParcela(contaFinanceiraId: string, contratoId: string): Promise<ParcelaErp | null>;
}
```

`lerParcela` mora no `ErpWriter` de propósito: é a **leitura de verificação** do write (read-back
de idempotência), não faz parte da superfície do agente e não passa pelo catálogo.

Arquivos: `tipos.ts` (Zod de entrada e saída, dinheiro em centavos na fronteira), `erros.ts`
(`ErpError`/`ErpAuthError`/`ErpBusinessError`/`ErpUnavailableError` + `erroDeResposta`),
`token.ts`, `http.ts`, `cliente.ts` (`createTseErpApi`), `simulado.ts` (fake em memória, para boot
sem TSE e testes unitários).

**Token.** `POST /token` — **não GET**: a coleção marca GET com body e `fetch` lança
`Request with GET/HEAD method cannot have body`; o endpoint OWIN do ASP.NET aceita POST. Corpo
`x-www-form-urlencoded`, resposta validada por Zod. Cache em memória com
`expiraEm = agora + expires_in - 300s`. **Promessa única em voo**: N chamadas concorrentes no boot
compartilham um refresh (senão o TSE recebe N logins e pode bloquear a conta). Em `401` de
qualquer rota: invalida, reautentica **uma vez**, repete **uma vez**; segundo `401` ⇒
`ErpAuthError`.

**Timeouts e retry.** `AbortSignal.timeout`, default 15 s. Retry só para `ErpUnavailableError` e
só em `GET` (até 2, backoff). **Escrita nunca faz retry dentro do adapter** — isso é decisão do
worker, protegida pela tabela de idempotência.

**Respostas em prosa.** `TransacaoEletronica` devolve `"Transação inserida com sucesso, sob id: 1"`
— string, não JSON. O adapter extrai o id com regex estrita (`/sob id:\s*(\d+)/`) e, se não casar,
lança `ErpBusinessError`. **HTTP 200 não é prova de sucesso** — teste nomeado obrigatório.

**Redação de PII no erro.** `payment-provider/src/erros.ts:57` faz `corpo.slice(0, 300)` para
dentro da mensagem. No TSE esse corpo traz `NomePessoa` e CPF, que iriam para os logs pino —
`packages/anonimizacao` cobre o que vai para a **LLM**, não o que vai para o **log**. A versão TSE
redige antes de cortar.

### Migração `0017_erp-escrita.sql` e a tabela `erp_escrita`
```
erp_escrita(
  chave      text primary key,   -- 'baixa:' || pagamento.id
  operacao   text not null,      -- baixa | reserva | lead | venda
  alvo       text not null,      -- idcontafinanceira / idcontrato
  payload    jsonb not null,
  estado     text not null,      -- pendente | confirmada | falha
  erp_id     text,
  tentativas integer not null default 0,
  erro       text,
  criado_em timestamptz, atualizado_em timestamptz)
```

### Worker `FILA_ERP_BAIXA` (`apps/server/src/erp/baixa.ts`)
1. `marcarPaga` **continua** gravando `pagamento` (é o nosso razão e a âncora de idempotência) e,
   na **mesma transação**, insere `erp_escrita` com `onConflictDoNothing`; **depois do commit**,
   `boss.send(FILA_ERP_BAIXA, {pagamentoId})` — o padrão que `registrarEventoPsp` já usa.
2. O worker tira a linha de `pendente` com `UPDATE … WHERE estado='pendente' RETURNING` (só uma
   execução vence), monta o input e chama `registrarPagamento`.
3. `estado='confirmada'` + `erp_id`. Falha definitiva ⇒ `estado='falha'` + ticket por
   `escalarTicketCobranca`. **Baixa nunca se perde em silêncio.**

Fila separada, e não um passo inline no `marcarPaga`, porque ali `concluir` + `throw` faz o evento
**inteiro** reprocessar (`eventos.ts:126-129`) — e cada retry reexecutaria `notificarPago`.

### Idempotência — `TransacaoEletronica` quase certamente não é idempotente no TSE
Quatro camadas, porque o webhook do Asaas reentrega e o pg-boss re-tenta:

1. **Guarda antes:** `erp_escrita.chave` é PK; `pagamento` já é único por `(cobranca_id,
   titulo_id)`. Já `confirmada` ⇒ o worker retorna sem chamar o TSE.
2. **Read-back depois — a única defesa real.** Timeout, erro de rede ou 200 com prosa não
   reconhecida ⇒ o worker **não repete o POST**: chama `lerParcela` e checa `Pago === true` com
   valor compatível. Já pago ⇒ `confirmada`. Não pago ⇒ aí sim repete.
3. **Rastro no próprio TSE:** `CodigoAutorizacao` recebe o id da cobrança no PSP em vez de um
   número inventado — dá ao financeiro o link e reforça o read-back. **Conferir o limite do campo**
   (no exemplo tem 6 caracteres); se truncar, hash curto determinístico e a correspondência em
   `erp_escrita.payload`.
4. **Retry limitado + humano:** `retryLimit: 5, retryBackoff: true`. `ErpAuthError` e
   `ErpBusinessError` não fazem retry — vão direto para humano.

### A conciliação vira compensação do que está em voo
`ERP_CONCILIACAO=auto|on|off`, default `auto`:
- `on` — comportamento de hoje;
- `off` — executor cru;
- `auto` — **o decorator só compensa `pagamento` cuja `erp_escrita` não está `confirmada`**.

`auto` **não muda `conciliacao.ts` nenhuma linha**. Muda uma query: `pagosDoContrato`
(`apps/server/src/pagamentos/repo.ts:64`) ganha
`AND NOT EXISTS (SELECT 1 FROM erp_escrita e WHERE e.chave = 'baixa:' || pagamento.id AND
e.estado = 'confirmada')`. Efeito: enquanto a baixa está em voo a conversa continua correta;
quando o TSE confirma, a compensação some e a verdade passa a ser do ERP — **sem contagem dupla em
nenhum instante**.

`conciliacao.ts` só é **apagado** na 041. Registrar como dívida com data.

### Fronteiras (`.dependency-cruiser.cjs`)
| Regra | De | Para |
|---|---|---|
| `agent-nao-importa-erp-api` (nova) | `^packages/agent` | `erp-api-tse` |
| `cobranca-nao-importa-erp-connector` (estender) | `^packages/cobranca` | + `erp-api-tse` |
| `sdr-nao-importa-erp-connector` (estender) | `^packages/sdr` | + `erp-api-tse` |
| `anonimizacao-so-conhece-ai-provider` (estender) | `^packages/anonimizacao` | + `erp-api-tse` |
| `erp-api-e-folha` (nova) | `^packages/erp-api-tse` | `agent\|query-catalog\|cobranca\|sdr\|guardrails\|crm\|skills\|rag\|wa-meta` |

**Regra sem fixture é regra não provada:** `tools/boundaries.spec.ts` prova cada regra contra
violadoras em `tools/fixtures/`. Acrescentar `import '@seta/erp-api-tse'` em
`tools/fixtures/packages/agent/src/index.ts` e as constantes no spec. Item de checklist do PR.

### Env
`TSE_BASE_URL`, `TSE_USERNAME`, `TSE_PASSWORD`, `ERP_CONCILIACAO`. `TSE_PASSWORD` entra em
`SENHAS_DE_DEV` (boot recusa valor de dev em produção) e nas regras do gitleaks da 026 — é
credencial de operador com poder de escrita financeira e de venda.

No homelab, `TSE_BASE_URL: http://tse-sim:3010` no serviço `server` do `infra/compose.prod.yml` —
o simulador que a 035 implanta, alcançável só pela rede interna do compose. Na 041 essa variável
passa a apontar para o TSE de verdade, e é a única coisa que muda.

## Fora de escopo
- Catálogo por HTTP (037) — as leituras continuam por SQL nesta fatia, **de propósito**.
- Reserva (038), lead/venda (039), 2ª via (040).
- Apagar `conciliacao.ts` (041).
- Apontar para o TSE real (041; bloqueado por ambiente).

## Premissas
- `cobranca_titulo.titulo_id` **é** o `idcontafinanceira` — confirmado em
  `infra/erp-mock/02-views.sql:83` (`t.idcontafinanceira::text AS id`).
- O `contrato_id` da sessão é o `IdContrato`, **não** o `NumeroContrato`
  (`02-views.sql:84`: `t.idcontrato::text`). No TSE são campos diferentes, e trocar devolve o
  financeiro de outro cotista — vazamento, não bug. Teste nomeado.
- `TransacaoEletronica` não é idempotente ⇒ read-back obrigatório.

## Critérios de aceite
- Fluxo de cobrança no simulador do console → "Simular pagamento" → webhook do Asaas →
  `pagamento` gravado → `erp_escrita.estado='confirmada'` → `SELECT datarecebimento FROM
  contafinanceira` preenchido.
- Na pergunta seguinte, `titulos_atraso` **não** lista a parcela, e `evento_query` mostra que o
  dado veio do ERP, não da compensação.
- Reprocessar o mesmo `evento_psp` **não** gera segunda transação no TSE (teste que reinjeta o
  evento e conta as linhas em `tse_sim.transacaoeletronica`).
- POST com timeout seguido de retry: o read-back detecta a parcela já paga e fecha como
  `confirmada` — **sem** segunda baixa.
- TSE fora do ar: `estado='pendente'`, retry, cotista avisado do pagamento mesmo assim, e a
  conciliação `auto` segura a conversa.
- `200` com prosa inesperada vira `ErpBusinessError`, não sucesso.
- `pnpm lint` verde **com** as fixtures novas de fronteira; `pnpm test && pnpm build` verdes.

## O que dá para demonstrar ao final
**A demo da semana 1.** "O cotista pagou no sandbox do Asaas; o webhook chegou; a parcela foi
baixada **no ERP** — olha o `SELECT` — e o agente confirma lendo o ERP, não um espelho nosso."

## Decisões a resolver (registrar a escolha na descrição do PR)
- `CodigoAutorizacao`: id do PSP inteiro ou hash curto (depende do limite do campo no TSE).
- `ERP_CONCILIACAO` default `auto` (recomendado) ou `on` até a 037 fechar.
- Nome do pacote: `@seta/erp-api-tse` ou `@seta/erp-api`.
