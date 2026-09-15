# seta-agente

## Regras do projeto
- **Stack travada** (SDK SETA v1.0): TypeScript estrito, Node 24 LTS, pnpm 10, Fastify 5,
  Zod, Drizzle, Postgres 17 + pgvector, pg-boss, Better Auth, pino, UUIDv7, LangGraph.js,
  Next.js (App Router) + React 19, Tailwind 4, shadcn/ui, Vitest, Biome, dependency-cruiser.
  Nenhuma dependência de infraestrutura fora dessa lista sem me perguntar antes.
- **Escopo**: trabalhe apenas na spec da sessão. O que está em "Fora de escopo" não entra,
  nem "de brinde". Se algo de outra spec bloquear, crie stub mínimo tipado e registre no PR.
- **Pronto** = todos os critérios de aceite da spec atendidos + `pnpm lint && pnpm test
  && pnpm build` verdes.
- **Fronteiras** (dependency-cruiser vigia): `packages/*` não importam de `apps/*`;
  `agent` não importa `erp-connector` (dado só via `query-catalog`); ports (`AIProvider`,
  `DbConnector`, `VectorStore`, `SkillRegistry`) expõem interface, nunca implementação.
- **Segurança**: SQL sempre com binds nomeados — interpolação/concatenação de valores em
  SQL é proibida em qualquer camada. Params `source: session` nunca vêm do LLM.
- **Convenções**: Zod em toda fronteira de entrada; IDs UUIDv7; logs pino estruturados com
  traceId; commits convencionais; `.env` nunca commitado e `.env.example` sempre atualizado.
- **Fluxo git**: branch `spec/NNN-nome` → implementar com testes → me mostrar resumo do
  diff → commits → PR. Não faça push sem eu confirmar.
- **Ambiguidade**: no máximo 3 perguntas antes de começar; fora isso, siga com premissa
  explícita e registre-a na descrição do PR.
- **Documentação**: `docs/README.md` é a porta de entrada; convenções e receitas em
  `docs/dev/06-como-desenvolver.md`; o que falta tem pré-spec em `specs/` (015b, 015c, 018+).
  Ao entregar uma spec, atualizar `docs/dev/04-modulos-entregues.md` e `specs/README.md`.

## Decisões registradas
- TypeScript pinado em `~5.9.x` (decisão do Renato, 2026-08-26): a linha 7.0 (tsgo) é
  recém-lançada; migrar só com aprovação explícita.
- Deps além da lista travada aprovadas em 2026-08-26: `yaml` (parser p/ client-config e
  catalog), `uuid` (UUIDv7) e `pg` (driver do Drizzle/Postgres).
- `@huggingface/transformers` aprovada em 2026-09-06 (spec 016): NER local para
  anonimização do que sai para a LLM — ONNX em Node, sem Python; modelo embarcado na
  imagem. Só `packages/anonimizacao` pode importar.
