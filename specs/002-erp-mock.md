# 002 — ERP mock (TS Explorer simulado)

## Objetivo
Banco `erp_mock` que faz o papel do TS Explorer atrás da MESMA fronteira do produto real:
o produto só enxerga views canônicas via usuário read-only.

## Escopo
- SQL puro em `infra/erp-mock/` (numerado, idempotente): tabelas "físicas" com nomes feios
  de ERP (ex.: `pcclient`, `pcpedido`, `pcprest`) e por cima as **views canônicas**:
  `v_cliente`, `v_pedido`, `v_item_pedido`, `v_titulo`, `v_estoque`, `v_tabela_preco`.
  A distância física→canônico é proposital: demonstra a camada semântica.
- Seed realista (script TS `pnpm db:seed:erp`, idempotente): ~20 clientes PJ com CNPJ
  plausível, ~500 pedidos nos últimos 90 dias com itens, títulos coerentes com os pedidos
  (abertos, vencidos, pagos), estoque por produto (~40 SKUs de distribuidora de bebidas),
  tabela de preço vigente. Datas relativas a `now()` para a demo nunca envelhecer.
- Usuário `erp_ro`: SELECT apenas nas views (não nas tabelas físicas). Testar que INSERT
  e SELECT em tabela física falham.
- `packages/erp-connector`:
  ```ts
  interface DbConnector {
    readonly dialect: 'postgres';
    execute(q: { sql: string; binds: Record<string, Scalar> }, o: ExecOptions): Promise<QueryResult>;
    health(): Promise<{ ok: boolean; latencyMs: number }>;
  }
  ```
  Impl `pg` com pool dedicado (user `erp_ro`), `SET LOCAL statement_timeout` por execução,
  corte em `maxRows + 1` linhas (flag `truncated`), binds nomeados → posicionais.
- Seed de vínculo no banco `app` (roda na 007, definir aqui): mapa wa_id→cliente_erp para
  os até 5 números de teste da demo.

## Critérios de aceite
- `pnpm db:seed:erp` popula tudo; rodar 2x não duplica.
- Teste de integração: `execute` respeita timeout (query com `pg_sleep`) e `maxRows`.
- Teste: `erp_ro` não lê tabela física nem escreve em nada.
