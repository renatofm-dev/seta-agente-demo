#!/bin/sh
# Seed de demo (011) DENTRO do container do server — idempotente.
# ERP mock (schema+dados) → app (usuários, vínculos, skills) → KB ingerida.
set -e
cd /app
node apps/server/erp-mock/seed.ts
node apps/server/dist/seed-app.js
node apps/server/dist/kb-ingest.js
echo "demo seed ok — Distribuidora Aurora pronta"
