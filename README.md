# seta-agente

POC do agente de atendimento autônomo da SETA (WhatsApp + ERP TS Explorer mock + HITL +
skills com aprovação). As specs em `specs/` são a fonte de verdade; regras em `CLAUDE.md`.

**Documentação de desenvolvimento:** [`docs/README.md`](docs/README.md) (visão geral,
arquitetura, mapa do repositório, módulos entregues, como desenvolver, operação, o que falta).

## Dev

```sh
pnpm i && cp .env.example .env && pnpm dev   # Postgres + server (:3001) + console (:3000)
pnpm dev-whatsapp                            # idem + túnel p/ WhatsApp real (e webhook do Asaas)
```

Pagamentos pelo WhatsApp (spec 014): sem `ASAAS_API_KEY` o PSP é simulado; com a chave do
sandbox, ver `docs/asaas-setup.md`. Decisão de fornecedor em `docs/adr/0001-asaas-como-psp.md`.

Nota: o script `dev` paraleliza os scripts da raiz com `pnpm run '/^dev:/'` (seletor por
regex) — `pnpm run --parallel` não serve aqui porque força modo recursivo no workspace e
não encontra os scripts `dev:*` da raiz.
