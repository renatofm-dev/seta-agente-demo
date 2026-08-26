# 003 — Catálogo de queries

## Objetivo
Única via de acesso a dado estruturado: o agente escolhe tool + parâmetros; nunca escreve SQL.

## Escopo
- Formato YAML por entrada em `catalog/<dominio>/<nome>.yaml`:
  `id, version, description, entities, modules, params{name:{type, source: session|agent,
  required, default}}, sql, limits{timeout_ms, max_rows}, output{columns, masking}, tool{expose, name}`.
- `packages/query-catalog`:
  - **Loader**: lê `catalog/`, valida com Zod, indexa por id. Falha no boot se inválido.
  - **Validador estático** (roda no loader E como teste): parse com `node-sql-parser`;
    reprova se: mais de um statement; qualquer coisa além de SELECT; objeto referenciado
    fora da allowlist (`v_*` canônicas); placeholder não-bind (interpolação `${}` ou
    concatenação); bind declarado sem param correspondente e vice-versa.
  - **Executor**: `run(id, rawParams, session)` → valida `source: agent` com Zod do param;
    injeta `source: session` a partir de `SessionCtx` (valor vindo do LLM para param de
    sessão é IGNORADO e logado); aplica limits; chama `DbConnector`; aplica masking por
    coluna no resultado; grava `evento_query` (010 consome).
  - **Codegen de tools**: converte entradas `tool.expose: true` em tools LangGraph
    (schema Zod só com params `source: agent`), filtradas por `modules` habilitados na
    config e por existência de vínculo na sessão.
- Entradas iniciais (com description caprichada — é o que o modelo lê):
  `cliente.perfil`, `financeiro.titulos_abertos`, `vendas.ultimos_pedidos`,
  `vendas.status_pedido`, `estoque.disponibilidade`, `preco.tabela_vigente`
  (única fonte de preço; marcar `price_source: true` no YAML).
- Masking demo: `v_cliente.cnpj` → `**.***.***/****-NN` (mecanismo genérico por coluna).

## Critérios de aceite
- Teste: entrada com interpolação/DDL/tabela física é rejeitada no load.
- Teste: chamada com `cliente_id` forjado pelo "modelo" retorna dados do cliente da sessão.
- Teste: masking aplicado antes do retorno; `evento_query` gravado com latência e linhas.
- Fixture de cada entrada inicial rodando contra o seed da 002.
