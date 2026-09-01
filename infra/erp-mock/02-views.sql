-- 02 — Views canônicas (spec 012): a ÚNICA superfície que o produto enxerga
-- (via erp_ro). Nomes e status alinhados com @seta/domain-erp; valores
-- monetários em centavos. Idempotente: DROP + CREATE (a coluna pode mudar de
-- forma entre specs, o que CREATE OR REPLACE não aceita); os grants do 03
-- rodam sempre depois.

DROP VIEW IF EXISTS
  v_cotista, v_contrato_cota, v_titulo, v_inadimplencia, v_cancelamento, v_chamado
  CASCADE;

-- Titular SEMPRE pseudonimizado: o papel de leitura do produto teve SELECT
-- revogado em pessoa/contrato por LGPD — a view nasce dentro dessa fronteira
-- e nunca carrega nome, CPF ou e-mail.
CREATE VIEW v_cotista AS
SELECT
  c.idcontrato::text                        AS contrato_id,
  c.numerocontrato                          AS numero_contrato,
  'Titular do contrato ' || c.numerocontrato AS titular,
  CASE
    WHEN c.statuscontrato IN ('ATIVO', 'ATIVOREV') THEN 'ativo'
    WHEN c.statuscontrato = 'CANCELADO'            THEN 'cancelado'
    WHEN c.statuscontrato = 'QUITADO'              THEN 'quitado'
  END                                       AS status,
  c.datavenda                               AS cliente_desde
FROM contrato c;

-- Grão contrato; idcotaativa com fallback para idcotaadquirida (regra do espelho).
CREATE VIEW v_contrato_cota AS
SELECT
  c.idcontrato::text   AS contrato_id,
  c.numerocontrato     AS numero_contrato,
  q.codigocota         AS cota_codigo,
  e.nome               AS bloco,
  u.andar              AS andar,
  u.numero             AS uh,
  u.capacidade         AS capacidade,
  g.nome               AS tier,
  m.qtdperiodos        AS periodos,
  c.qtdpontos          AS pontos,
  CASE
    WHEN c.statuscontrato IN ('ATIVO', 'ATIVOREV') THEN 'ativo'
    WHEN c.statuscontrato = 'CANCELADO'            THEN 'cancelado'
    WHEN c.statuscontrato = 'QUITADO'              THEN 'quitado'
  END                  AS status
FROM contrato c
JOIN cotauh q            ON q.idcotauh = coalesce(c.idcotaativa, c.idcotaadquirida)
JOIN unidadehoteleira u  ON u.idunidadehoteleira = q.idunidadehoteleira
JOIN edificiohotel e     ON e.idedificiohotel = u.idedificiohotel
JOIN grupocota g         ON g.idgrupocota = q.idgrupocota
JOIN modelocota m        ON m.idmodelocota = q.idmodelocota;

-- Grão parcela; só tipohistorico ATIVO. O vencimento de referência é
-- datavencimentorecorrencia (a origem reescreve datavencimento quando a
-- recorrente é paga) e datas fora da janela de sanidade são descartadas.
CREATE VIEW v_titulo AS
SELECT
  t.idcontafinanceira::text  AS id,
  t.idcontrato::text         AS contrato_id,
  CASE o.nome WHEN 'ENTRADA' THEN 'entrada' ELSE 'saldo' END AS origem,
  t.numeroparcela            AS parcela,
  t.qtdparcelas              AS total_parcelas,
  CASE mp.nome
    WHEN 'BOLETO'           THEN 'boleto'
    WHEN 'PIX'              THEN 'pix'
    WHEN 'CARTAORECORRENTE' THEN 'cartao_recorrente'
  END                        AS meio_pagamento,
  (t.valorreceber * 100)::bigint                    AS valor_centavos,
  (coalesce(t.valorrecebido, 0) * 100)::bigint      AS valor_pago_centavos,
  coalesce(t.datavencimentorecorrencia, t.datavencimento) AS vencimento,
  t.datarecebimento          AS pagamento,
  CASE
    WHEN t.datarecebimento IS NOT NULL THEN 'pago'
    WHEN coalesce(t.datavencimentorecorrencia, t.datavencimento) < current_date THEN 'vencido'
    ELSE 'aberto'
  END                        AS status,
  t.linhadigitavel           AS linha_digitavel,
  t.pixcopiaecola            AS pix_copia_cola
FROM contafinanceira t
JOIN tipoorigemcontafinanceira o ON o.idtipoorigemcontafinanceira = t.idtipoorigemcontafinanceira
JOIN meiopagamento mp            ON mp.idmeiopagamento = t.idmeiopagamento
WHERE t.tipohistorico = 'ATIVO'
  AND coalesce(t.datavencimentorecorrencia, t.datavencimento)
      BETWEEN DATE '2020-01-01' AND current_date + interval '30 years';

-- Agregado de vencidos por contrato (grão contrato).
CREATE VIEW v_inadimplencia AS
SELECT
  contrato_id,
  count(*)::int                          AS qtd_titulos_vencidos,
  sum(valor_centavos)::bigint            AS saldo_vencido_centavos,
  min(vencimento)                        AS vencimento_mais_antigo,
  (current_date - min(vencimento))::int  AS maior_atraso_dias
FROM v_titulo
WHERE status = 'vencido'
GROUP BY contrato_id;

-- Último distrato por contrato (grão contrato).
CREATE VIEW v_cancelamento AS
SELECT DISTINCT ON (cc.idcontrato)
  cc.idcontrato::text  AS contrato_id,
  CASE cc.statuscancelamento
    WHEN 'EMANALISE' THEN 'em_analise'
    WHEN 'CONCLUIDO' THEN 'concluido'
    WHEN 'NEGADO'    THEN 'negado'
  END                  AS status,
  mc.descricao         AS motivo,
  cc.datasolicitacao   AS solicitado_em,
  (coalesce(cc.valormulta, 0) * 100)::bigint      AS multa_centavos,
  (coalesce(cc.valorreembolso, 0) * 100)::bigint  AS reembolso_centavos
FROM cancelamento cc
JOIN motivocancelamentocontrato mc
  ON mc.idmotivocancelamentocontrato = cc.idmotivocancelamentocontrato
ORDER BY cc.idcontrato, cc.datasolicitacao DESC, cc.idcancelamento DESC;

-- Ocorrências de atendimento do titular, expostas por contrato (a sessão do
-- produto conhece o contrato, não a pessoa).
CREATE VIEW v_chamado AS
SELECT
  oc.idocorrenciaatendimentots::text  AS id,
  c.idcontrato::text                  AS contrato_id,
  CASE oc.statusocorrencia
    WHEN 'ABERTA'      THEN 'aberto'
    WHEN 'EMANDAMENTO' THEN 'em_andamento'
    WHEN 'FINALIZADA'  THEN 'finalizado'
  END                                 AS status,
  mo.descricao                        AS motivo,
  oc.dataabertura                     AS abertura,
  oc.datafinalizacao                  AS finalizacao
FROM ocorrenciaatendimentots oc
JOIN motivocontato mo ON mo.idmotivocontato = oc.idmotivocontato
JOIN contrato c       ON c.idpessoatitular = oc.idpessoa;
