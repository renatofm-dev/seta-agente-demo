# 018 — Conexão ao espelho real do cliente-piloto

> **Pré-spec** (rascunho de 08/09/2026): ainda não executada. Depende de **D5** (acesso ao
> espelho: host, papel read-only, rede) e da premissa **D3** (Bali Park). Item P-36, marco M4.

## Objetivo
A plataforma lê o ERP por 7 views canônicas (`infra/erp-mock/02-views.sql`) desenhadas a
partir do espelho `bali_tse` (36 tabelas replicadas em `bali-vps`), mas até hoje só rodou
contra o `erp_mock`. Esta spec aponta `ERP_DATABASE_URL` para o espelho real, prova que as
views batem com o TSE de verdade (nomes, tipos, semântica dos status), fecha a política de
masking do catálogo e garante que o papel de leitura não enxerga tabela física nem PII.

## Reaproveita
- `infra/erp-mock/{02-views,03-grants}.sql`: as views e os grants são o contrato — no
  espelho elas são criadas **iguais**, sobre as tabelas físicas do TSE.
- `packages/erp-connector` (`createPgConnector`, timeout, binds nomeados) não muda.
- `packages/query-catalog/src/masking.ts` (`MASKERS`, hoje só `cnpj`) e `loader.ts` (rejeita
  masker desconhecido).
- `packages/domain-erp` (status canônicos: `ATIVO`+`ATIVOREV` ⇒ `ativo` etc.) e a spec 012
  (levantamento do espelho, o que não existe: reserva, calendário, check-in).
- Papel `bali_agente` já criado no espelho com SELECT revogado em `pessoa` e `contrato`
  (memória do projeto `espelho-bali-vps`).
- `catalog/**/*.yaml` e os testes de `query-catalog` com fixtures.

## Escopo

### Espelho (`infra/erp-real/` — scripts versionados, executados pelo DBA/CTO)
- `views.sql`: as 7 views canônicas sobre as tabelas físicas do TSE, com os mesmos nomes
  e colunas do mock; diferenças reais (nomes de tabela, status extras) ficam **dentro** da
  view, nunca no catálogo.
- `grants.sql`: papel `seta_ro` (ou o `bali_agente` existente): `USAGE` no schema,
  `SELECT` só nas 7 views, `REVOKE ALL` nas tabelas; `statement_timeout` de sessão (3 s).
- `smoke.sql`: consultas de sanidade por view (contagem, amostra sem PII).

### Teste de contrato (`apps/server/test/erp-contrato.integration.test.ts`)
- Para cada view: colunas e tipos iguais aos do mock (`information_schema`), uma consulta
  de cada entrada do catálogo com `contrato_id` real anonimizado devolve linhas válidas
  pelo schema de `output.columns`; nenhuma coluna com nome, CPF, e-mail, telefone ou
  endereço aparece em `SELECT *` de view alguma; `SELECT` em tabela física falha com
  permissão negada.
- Roda com `ERP_CONTRATO_URL` (opcional) contra o espelho; no CI é `skipIf` sem a URL.

### Catálogo e masking
- Política completa de masking em `masking.ts`: `cpf` (só dígitos finais), `telefone`,
  `email`, `nome` (iniciais) — mesmo que as views não devolvam PII, o catálogo passa a ter
  como declarar; `loader` exige `masking` explícito (`{}` quando não há).
- Revisar cada `catalog/**/*.yaml` contra o espelho: `titulos_atraso` com
  `datavencimentorecorrencia`, status de contrato e de título, `v_cota_disponivel` com a
  tabela de preço real (`tabelapreco` da 015 pode não existir no TSE — a view resolve).
- `ERP_DATABASE_URL` do piloto no `.env.prod`; `ERP_MOCK_ADMIN_URL` só em dev.

### Operação
- `docs/dev/05-dados-e-integracoes.md` e `deploy-homelab.md` ganham a seção "espelho real":
  rede, papel, rotação de senha, como rodar o `smoke.sql`.
- Boot loga `erp: espelho <host> (views 7/7)` após um `SELECT 1` em cada view; falha em
  qualquer uma derruba o boot (nunca "meio conectado").

## Fora de escopo
- Escrita no ERP (baixa de pagamento real) — o ERP continua read-only; a conciliação da 014
  permanece.
- Adaptador para outro ERP (028).
- Replicação do espelho em si (é do cliente).

## Premissas
- O espelho é uma cópia sincronizada, read-only, com nome e CPF inacessíveis ao papel da
  plataforma (é como foi montado em 08/2026).
- As diferenças entre mock e real cabem nas views; se alguma exigir mudança de contrato
  (coluna nova), o mock muda junto e a `domain-erp` também — no mesmo PR.
- `contatos.yaml` do piloto vem do cadastro do cliente (024 trata a base legal do CPF).

## Critérios de aceite
- Com `ERP_DATABASE_URL` no espelho: `titulos_atraso` de um contrato real bate com o que o
  TSE mostra para o mesmo contrato (validado na reunião semanal com o cliente).
- Teste de contrato verde contra o espelho e `skip` no CI sem URL.
- Papel de leitura não consegue `SELECT` em nenhuma tabela física; nenhuma coluna de PII
  nas 7 views.
- Loader rejeita YAML sem `masking` explícito; maskers novos testados.
- Boot com view faltando falha com mensagem clara; `pnpm lint && pnpm test && pnpm build`
  verdes.
