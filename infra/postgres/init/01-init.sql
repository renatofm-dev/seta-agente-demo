-- Init do Postgres dev (roda uma única vez, no primeiro boot do volume).
-- Dois bancos: app (produto, rw via app_owner) e erp_mock (ERP simulado, ro via erp_ro).
-- Grants de SELECT em erp_mock chegam na spec 002, junto com o schema.

CREATE ROLE app_owner LOGIN PASSWORD 'app_owner_dev';
CREATE ROLE erp_ro LOGIN PASSWORD 'erp_ro_dev';

CREATE DATABASE app OWNER app_owner;
CREATE DATABASE erp_mock;

GRANT CONNECT ON DATABASE erp_mock TO erp_ro;
REVOKE CREATE ON DATABASE erp_mock FROM PUBLIC;

-- pgvector no banco do produto (usado pelo RAG na spec 008; extensão já preparada aqui)
\connect app
CREATE EXTENSION IF NOT EXISTS vector;
