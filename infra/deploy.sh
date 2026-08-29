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

echo "== subindo server + console"
"${COMPOSE[@]}" up -d

echo "== healthcheck"
sleep 3
curl -fsS http://127.0.0.1:3001/healthz && echo
echo "deploy ok — https://seta.outerlab.com.br"
echo "seed de demo (idempotente): ${COMPOSE[*]} exec server sh /app/demo-seed.sh"
