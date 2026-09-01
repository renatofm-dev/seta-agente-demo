-- 03 — Fronteira de acesso: erp_ro só lê as views canônicas.
-- Tabelas físicas ficam invisíveis (as views rodam com o privilégio do dono) —
-- inclusive pessoa/contrato, cujo SELECT é revogado por LGPD no espelho real.
-- Idempotente: revoga tudo e re-concede só o necessário.

GRANT USAGE ON SCHEMA public TO erp_ro;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM erp_ro;
REVOKE CREATE ON SCHEMA public FROM erp_ro;

GRANT SELECT ON
  v_cotista, v_contrato_cota, v_titulo, v_inadimplencia, v_cancelamento, v_chamado
TO erp_ro;
