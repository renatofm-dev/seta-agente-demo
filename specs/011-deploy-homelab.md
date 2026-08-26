# 011 — Deploy no homelab + roteiro da demo

## Objetivo
POC no ar em `seta.outerlab.com.br`, com seed de demo e roteiro ensaiado.

## Escopo
- `compose.prod.yml`: services `db` (pgvector/pgvector:pg17, volume nomeado, bancos app +
  erp_mock), `server`, `console` (Next standalone). Caddy é o do host: adicionar site block
  `seta.outerlab.com.br` → reverse_proxy para console e `/webhook* /api/*` para o server.
  DNS: registro wildcard já cobre; conferir proxy Cloudflare ligado (ok para webhook Meta).
- **Imagens**: build no GitHub Actions → push GHCR (conta pessoal, repo privado, PAT com
  `read:packages` na VPS). NÃO buildar na VPS: CX23 tem 4 GB — build do Next estoura.
  Deploy = `docker compose pull && up -d`. Script `deploy.sh` documentado.
- Recursos: criar swap de 2 GB; `NODE_OPTIONS=--max-old-space-size=512` nos services Node;
  logs com rotação (`max-size`).
- `.env.prod` na VPS (fora do git): Meta (token, app secret, verify token, phone number id),
  LLM (base url, key, modelo, embedding), Better Auth secret, URLs.
- **Seed de demo** (`pnpm demo:seed`, idempotente): ERP mock + vínculos dos números de teste
  + usuários (atendente, curador) + KB ingerida + 2 skills seed + config do cliente demo
  "Distribuidora Aurora".
- Webhook Meta apontado para produção; smoke test: mensagem real do celular → resposta.
- `docs/roteiro-demo.md`: os 4 atos da 000 com as mensagens EXATAS a enviar, o que mostrar
  em cada tela, e plano B (simulador). Checklist pré-demo: seed rodado, janela de 24 h
  aberta (mandar oi antes), fila limpa, usuários logados em dois browsers.

## Critérios de aceite
- Roteiro completo executado de ponta a ponta em produção, do celular, sem terminal.
- `docker compose restart` no meio de uma conversa não perde mensagens (outbox + idempotência).
- Restore do volume do Postgres testado uma vez (backup manual documentado).
