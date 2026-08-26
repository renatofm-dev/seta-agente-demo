-- 03 — Fronteira de acesso: erp_ro só lê as views canônicas.
-- Tabelas físicas ficam invisíveis (as views rodam com o privilégio do dono).
-- Idempotente: revoga tudo e re-concede só o necessário.

GRANT USAGE ON SCHEMA public TO erp_ro;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM erp_ro;
REVOKE CREATE ON SCHEMA public FROM erp_ro;

GRANT SELECT ON v_cliente, v_pedido, v_item_pedido, v_titulo, v_estoque, v_tabela_preco TO erp_ro;
