-- 04 — Terceiro papel do erp_mock: `tse_sim`, a credencial do simulador da API
-- (spec 035). O simulador ESCREVE nas tabelas físicas — é o que destrava baixa
-- de pagamento, reserva e venda —, mas continua cego para as views canônicas:
-- quem lê o ERP pelo produto é o erp_ro, e essa fronteira não se mistura.
--
--   postgres  → tudo (pnpm db:seed:erp)
--   erp_ro    → só as 7 views canônicas (produto, ERP_DATABASE_URL)
--   tse_sim   → SELECT/INSERT/UPDATE nas tabelas físicas, ZERO nas views
--
-- Idempotente. A senha vem do seed (`TSE_SIM_DB_PASSWORD`), nunca literal aqui:
-- o arquivo é versionado e a senha de produção não pode morar no git.

DO $$
DECLARE
  senha text := coalesce(nullif(current_setting('seta.tse_sim_password', true), ''), 'tse_sim_dev');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tse_sim') THEN
    EXECUTE format('ALTER ROLE tse_sim LOGIN PASSWORD %L', senha);
  ELSE
    EXECUTE format('CREATE ROLE tse_sim LOGIN PASSWORD %L', senha);
  END IF;
END $$;

GRANT CONNECT ON DATABASE erp_mock TO tse_sim;
GRANT USAGE ON SCHEMA public TO tse_sim;
REVOKE CREATE ON SCHEMA public FROM tse_sim;

-- tabelas físicas nomeadas uma a uma: `ON ALL TABLES` alcançaria as views
-- também, e um GRANT de escrita em view é justamente o que esta fronteira nega
GRANT SELECT, INSERT, UPDATE ON
  edificiohotel, unidadehoteleira, grupocota, modelocota, tabelapreco, cotauh,
  pessoa, contrato, tipoorigemcontafinanceira, meiopagamento, contafinanceira,
  motivocancelamentocontrato, cancelamento, motivocontato, ocorrenciaatendimentots
TO tse_sim;

-- explícito, não redundante: as views são recriadas a cada `db:seed:erp` (o 02
-- faz DROP+CREATE) e um GRANT futuro distraído não passa por aqui sem aviso
REVOKE ALL ON
  v_cotista, v_contrato_cota, v_titulo, v_inadimplencia, v_cancelamento, v_chamado,
  v_cota_disponivel
FROM tse_sim;
