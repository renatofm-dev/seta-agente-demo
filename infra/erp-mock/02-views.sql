-- 02 — Views canônicas: a ÚNICA superfície que o produto enxerga (via erp_ro).
-- Nomes e status alinhados com @seta/domain-erp; valores monetários em centavos.
-- Idempotente: CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW v_cliente AS
SELECT
  codcli::text          AS id,
  cgcent                AS documento,
  cliente               AS razao_social,
  fantasia              AS nome_fantasia
FROM pcclient
WHERE bloqueio = 'N';

CREATE OR REPLACE VIEW v_pedido AS
SELECT
  p.numped::text        AS id,
  p.codcli::text        AS cliente_id,
  p.dtemis              AS emissao,
  CASE p.posicao
    WHEN 'P' THEN 'recebido'
    WHEN 'F' THEN 'faturado'
    WHEN 'S' THEN 'em_separacao'
    WHEN 'T' THEN 'em_transporte'
    WHEN 'E' THEN 'entregue'
    WHEN 'C' THEN 'cancelado'
  END                   AS status,
  (p.vltotal * 100)::bigint AS total_centavos
FROM pcpedido p;

CREATE OR REPLACE VIEW v_item_pedido AS
SELECT
  i.numped::text        AS pedido_id,
  i.numseq              AS seq,
  i.codprod::text       AS produto_id,
  pr.descricao          AS produto,
  i.qt                  AS quantidade,
  (i.punit * 100)::bigint      AS preco_unit_centavos,
  (i.vlsubtotal * 100)::bigint AS subtotal_centavos
FROM pcpediitem i
JOIN pcprodut pr ON pr.codprod = i.codprod;

CREATE OR REPLACE VIEW v_titulo AS
SELECT
  t.numtit::text        AS id,
  t.codcli::text        AS cliente_id,
  t.numped::text        AS pedido_id,
  (t.valor * 100)::bigint AS valor_centavos,
  t.dtvenc              AS vencimento,
  CASE
    WHEN t.dtpago IS NOT NULL        THEN 'pago'
    WHEN t.dtvenc < current_date     THEN 'vencido'
    ELSE 'aberto'
  END                   AS status,
  t.linhadig            AS linha_digitavel
FROM pcprest t;

CREATE OR REPLACE VIEW v_estoque AS
SELECT
  e.codprod::text       AS produto_id,
  pr.descricao          AS produto,
  (e.qtestger - e.qtreserv) AS disponivel,
  e.qtreserv            AS reservado
FROM pcest e
JOIN pcprodut pr ON pr.codprod = e.codprod;

CREATE OR REPLACE VIEW v_tabela_preco AS
SELECT
  t.codprod::text       AS produto_id,
  pr.descricao          AS produto,
  (t.pvenda * 100)::bigint AS preco_centavos,
  t.dtinicio            AS vigente_desde
FROM pctabpreco t
JOIN pcprodut pr ON pr.codprod = t.codprod
WHERE t.numregiao = 1
  AND t.dtinicio <= current_date
  AND (t.dtfim IS NULL OR t.dtfim >= current_date);
