-- 01 — Tabelas "físicas" do TS Explorer simulado (nomes feios de ERP, de propósito:
-- a distância físico→canônico demonstra a camada semântica das views).
-- Idempotente: CREATE TABLE IF NOT EXISTS. O produto NUNCA enxerga estas tabelas.

CREATE TABLE IF NOT EXISTS pcclient (
  codcli    integer PRIMARY KEY,
  cgcent    varchar(18) NOT NULL, -- CNPJ formatado
  cliente   varchar(80) NOT NULL, -- razão social
  fantasia  varchar(40),
  dtcad     date NOT NULL,
  bloqueio  char(1) NOT NULL DEFAULT 'N' -- S/N
);

CREATE TABLE IF NOT EXISTS pcprodut (
  codprod      integer PRIMARY KEY,
  descricao    varchar(80) NOT NULL,
  embalagem    varchar(20) NOT NULL, -- ex.: CX 12, PK 6, FD 15
  unidade      char(2) NOT NULL,     -- CX, UN, FD
  codauxiliar  varchar(14)           -- EAN
);

CREATE TABLE IF NOT EXISTS pcpedido (
  numped   integer PRIMARY KEY,
  codcli   integer NOT NULL REFERENCES pcclient (codcli),
  dtemis   date NOT NULL,
  posicao  char(1) NOT NULL, -- P=pendente F=faturado S=separacao T=transporte E=entregue C=cancelado
  vltotal  numeric(14, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS pcpediitem (
  numped      integer NOT NULL REFERENCES pcpedido (numped),
  numseq      integer NOT NULL,
  codprod     integer NOT NULL REFERENCES pcprodut (codprod),
  qt          numeric(10, 2) NOT NULL,
  punit       numeric(12, 4) NOT NULL,
  vlsubtotal  numeric(14, 2) NOT NULL,
  PRIMARY KEY (numped, numseq)
);

CREATE TABLE IF NOT EXISTS pcprest (
  numtit    integer PRIMARY KEY,
  prest     char(2) NOT NULL,  -- nº da parcela: 01, 02...
  codcli    integer NOT NULL REFERENCES pcclient (codcli),
  numped    integer REFERENCES pcpedido (numped),
  valor     numeric(14, 2) NOT NULL,
  dtvenc    date NOT NULL,
  dtpago    date,
  codcob    char(4) NOT NULL DEFAULT 'BOL', -- BOL=boleto D=dinheiro BK=banco
  linhadig  varchar(54)
);

CREATE TABLE IF NOT EXISTS pcest (
  codprod   integer PRIMARY KEY REFERENCES pcprodut (codprod),
  qtestger  numeric(12, 2) NOT NULL, -- estoque geral
  qtreserv  numeric(12, 2) NOT NULL DEFAULT 0,
  dtultent  date -- última entrada
);

CREATE TABLE IF NOT EXISTS pctabpreco (
  numregiao  integer NOT NULL,
  codprod    integer NOT NULL REFERENCES pcprodut (codprod),
  pvenda     numeric(12, 2) NOT NULL,
  dtinicio   date NOT NULL,
  dtfim      date,
  PRIMARY KEY (numregiao, codprod, dtinicio)
);
