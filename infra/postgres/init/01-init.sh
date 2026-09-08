#!/bin/bash
# Init do Postgres (roda uma única vez, no primeiro boot do volume).
# Dois bancos: app (produto, rw via app_owner) e erp_mock (ERP simulado, ro via erp_ro).
# Grants de SELECT em erp_mock chegam com o schema do ERP (spec 002/012).
#
# P-29: as senhas dos papéis vêm do ambiente do container. Sem elas (dev), valem
# os defaults de desenvolvimento; em produção o compose exige APP_OWNER_PASSWORD
# e ERP_RO_PASSWORD no .env.prod, e o server recusa subir com a senha de dev.
set -euo pipefail

APP_OWNER_PASSWORD="${APP_OWNER_PASSWORD:-app_owner_dev}"
ERP_RO_PASSWORD="${ERP_RO_PASSWORD:-erp_ro_dev}"

# :'var' é a citação do psql — escapa aspas na senha sem interpolar SQL na mão
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_pw="$APP_OWNER_PASSWORD" -v ro_pw="$ERP_RO_PASSWORD" <<-'EOSQL'
  CREATE ROLE app_owner LOGIN PASSWORD :'app_pw';
  CREATE ROLE erp_ro LOGIN PASSWORD :'ro_pw';

  CREATE DATABASE app OWNER app_owner;
  CREATE DATABASE erp_mock;

  GRANT CONNECT ON DATABASE erp_mock TO erp_ro;
  REVOKE CREATE ON DATABASE erp_mock FROM PUBLIC;
EOSQL

# pgvector no banco do produto (RAG, spec 008)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname app \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
