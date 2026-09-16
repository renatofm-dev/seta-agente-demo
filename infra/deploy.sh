#!/usr/bin/env bash
# Deploy na VPS (011): pull das imagens do GHCR + migrações + up.
# Pré-requisitos (uma vez): docs/deploy-homelab.md (login GHCR, .env.prod, swap).
# Uso: ./infra/deploy.sh [tag]   (default: latest)
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-latest}" export TAG
COMPOSE=(docker compose -f infra/compose.prod.yml --env-file .env.prod)

echo "== pull das imagens (:$TAG)"
"${COMPOSE[@]}" pull

echo "== banco no ar"
"${COMPOSE[@]}" up -d db

echo "== migrações"
"${COMPOSE[@]}" run --rm server node apps/server/dist/migrate.js

echo "== subindo server + console + simulador do TSE"
"${COMPOSE[@]}" up -d

echo "== healthcheck"
sleep 3
curl -fsS http://127.0.0.1:3001/healthz && echo
# 035: o tse-sim não publica porta (só a rede interna do compose), então o
# healthcheck sai de dentro do container — de fora ele não é alcançável, e é assim que deve ser
"${COMPOSE[@]}" exec -T tse-sim node -e \
  'fetch("http://localhost:3010/healthz").then(r=>r.text()).then(t=>console.log("tse-sim:",t))'
echo "deploy ok — https://seta.outerlab.com.br"
echo "seed de demo (idempotente): ${COMPOSE[*]} exec server sh /app/demo-seed.sh"
