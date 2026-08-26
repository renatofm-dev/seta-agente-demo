# Specs da POC — Agente TS Explorer (SETA)

Conjunto de specs para desenvolver a POC de demonstração do produto de atendimento
autônomo sobre WhatsApp, rodando local (repo privado + homelab), fora da org setaia.

## Como usar
- Uma spec = uma sessão de Claude Code = um PR. A spec é a fonte de verdade da sessão.
- Ordem de execução respeitando o grafo abaixo. "Pronto" = critérios de aceite atendidos + testes passando.
- Stack travada (SDK SETA v1.0): TypeScript, Node 24 LTS, pnpm 10, Fastify 5, Zod, Drizzle,
  Postgres 17 + pgvector, pg-boss, Better Auth, pino, UUIDv7, LangGraph.js, Next.js + React 19,
  Tailwind 4, shadcn/ui, Vitest, Biome, dependency-cruiser. Nada fora disso sem ADR.
- Estrutura de pastas idêntica à arquitetura alvo do produto. A migração futura para a org setaia
  deve ser: trocar remote + subir CI — zero refactor.

## Grafo de dependências
```
001 fundacao
 ├─► 002 erp-mock ─► 003 catalogo-queries ─┐
 ├─► 004 gateway-whatsapp ─────────────────┼─► 005 runtime-agente ─► 006 guardrails
 ├─► 008 rag ──────────────────────────────┘            │
 └─► 007 crm-console-hitl ◄─────────────────────────────┤
                    └──────────► 009 skills-aprendizado ┘
010 observabilidade (transversal, depois de 005)
011 deploy-homelab (final)
```

## Sequência sugerida (solo, começando hoje)
1. **Hoje**: 001 + início de 002. Em paralelo (15 min de browser): criar app Meta com
   número de teste do WhatsApp e obter chave do provedor LLM.
2. 003 → 004 (com simulador) → 005: aqui já existe um agente conversável via simulador.
3. 007 (console mínimo) → 006 → 009 (o diferencial da demo).
4. 008 → 010 → 011 e ensaio do roteiro.

## Convenções
- Toda fronteira valida com Zod. IDs UUIDv7. Logs pino estruturados com traceId.
- Interfaces dos ports (`AIProvider`, `DbConnector`, `VectorStore`, `SkillRegistry`)
  ficam em packages próprios; implementações nunca vazam para quem consome o port.
- Commits convencionais. `.env` nunca commitado; `.env.example` sempre atualizado.
