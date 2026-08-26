# seta-agente

POC do agente de atendimento autônomo da SETA (WhatsApp + ERP TS Explorer mock + HITL +
skills com aprovação). As specs em `specs/` são a fonte de verdade; regras em `CLAUDE.md`.

## Dev

```sh
pnpm i && cp .env.example .env && pnpm dev   # Postgres + server (:3001) + console (:3000)
```

Nota: o script `dev` paraleliza os scripts da raiz com `pnpm run '/^dev:/'` (seletor por
regex) — `pnpm run --parallel` não serve aqui porque força modo recursivo no workspace e
não encontra os scripts `dev:*` da raiz.
