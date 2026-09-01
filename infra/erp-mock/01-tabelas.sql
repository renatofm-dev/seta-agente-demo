-- 01 — Tabelas "físicas" do TS Explorer simulado (spec 012): nomes e colunas
-- espelham o TS Explorer real (bali_tse), de propósito — a distância
-- físico→canônico demonstra a camada semântica das views.
-- Idempotente: CREATE TABLE IF NOT EXISTS. O produto NUNCA enxerga estas tabelas.

-- limpeza do domínio da 002 (distribuidora Winthor) — substituído por esta spec
DROP VIEW IF EXISTS v_cliente, v_pedido, v_item_pedido, v_estoque, v_tabela_preco CASCADE;
DROP TABLE IF EXISTS pctabpreco, pcest, pcprest, pcpediitem, pcpedido, pcprodut, pcclient CASCADE;

-- estrutura hoteleira -------------------------------------------------------

CREATE TABLE IF NOT EXISTS edificiohotel (
  idedificiohotel  integer PRIMARY KEY,
  nome             varchar(60) NOT NULL -- ex.: TORRE 1
);

CREATE TABLE IF NOT EXISTS unidadehoteleira (
  idunidadehoteleira  integer PRIMARY KEY,
  idedificiohotel     integer NOT NULL REFERENCES edificiohotel (idedificiohotel),
  numero              varchar(10) NOT NULL, -- ex.: 1203
  andar               integer NOT NULL,
  capacidade          integer NOT NULL -- hóspedes
);

-- produto cota --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS grupocota (
  idgrupocota  integer PRIMARY KEY,
  nome         varchar(40) NOT NULL -- OURO/DIAMANTE × PREMIUM/MASTER/SPECIAL
);

CREATE TABLE IF NOT EXISTS modelocota (
  idmodelocota  integer PRIMARY KEY,
  nome          varchar(60) NOT NULL,
  qtdperiodos   integer NOT NULL -- períodos de uso que a cota confere
);

CREATE TABLE IF NOT EXISTS cotauh (
  idcotauh            integer PRIMARY KEY,
  idunidadehoteleira  integer NOT NULL REFERENCES unidadehoteleira (idunidadehoteleira),
  idgrupocota         integer NOT NULL REFERENCES grupocota (idgrupocota),
  idmodelocota        integer NOT NULL REFERENCES modelocota (idmodelocota),
  codigocota          varchar(20) NOT NULL,
  statuscota          varchar(30) NOT NULL -- VENDIDA | DISPONIVEL | BLOQUEIOADMINISTRATIVO
);

-- pessoas e contratos -------------------------------------------------------

-- dado pessoal REAL na física; o papel de leitura do produto não enxerga esta
-- tabela (LGPD) — só a v_cotista pseudonimizada
CREATE TABLE IF NOT EXISTS pessoa (
  idpessoa  integer PRIMARY KEY,
  nome      varchar(120) NOT NULL,
  cpf       varchar(14) NOT NULL,
  email     varchar(120)
);

CREATE TABLE IF NOT EXISTS contrato (
  idcontrato        integer PRIMARY KEY,
  numerocontrato    varchar(20) NOT NULL,
  idpessoatitular   integer NOT NULL REFERENCES pessoa (idpessoa),
  idcotaadquirida   integer NOT NULL REFERENCES cotauh (idcotauh),
  idcotaativa       integer REFERENCES cotauh (idcotauh), -- NULL ⇒ vale a adquirida
  statuscontrato    varchar(20) NOT NULL, -- ATIVO | ATIVOREV | CANCELADO | QUITADO
  datavenda         date NOT NULL,
  qtdpontos         integer NOT NULL -- contrato híbrido cota + pontos
);

-- financeiro (crediário próprio) --------------------------------------------

CREATE TABLE IF NOT EXISTS tipoorigemcontafinanceira (
  idtipoorigemcontafinanceira  integer PRIMARY KEY,
  nome                         varchar(40) NOT NULL -- ENTRADA | SALDO
);

CREATE TABLE IF NOT EXISTS meiopagamento (
  idmeiopagamento  integer PRIMARY KEY,
  nome             varchar(40) NOT NULL -- BOLETO | PIX | CARTAORECORRENTE
);

CREATE TABLE IF NOT EXISTS contafinanceira (
  idcontafinanceira            integer PRIMARY KEY,
  idcontrato                   integer NOT NULL REFERENCES contrato (idcontrato),
  idtipoorigemcontafinanceira  integer NOT NULL
    REFERENCES tipoorigemcontafinanceira (idtipoorigemcontafinanceira),
  idmeiopagamento              integer NOT NULL REFERENCES meiopagamento (idmeiopagamento),
  numeroparcela                integer NOT NULL,
  qtdparcelas                  integer NOT NULL,
  valorreceber                 numeric(14, 2) NOT NULL,
  valorrecebido                numeric(14, 2),
  -- a origem REESCREVE datavencimento quando a recorrente é paga; a referência
  -- confiável de vencimento é datavencimentorecorrencia (regra auditada no espelho)
  datavencimento               date NOT NULL,
  datavencimentorecorrencia    date,
  datarecebimento              date,
  tipohistorico                varchar(20) NOT NULL, -- ATIVO | CANCELADO | RENEGOCIADO
  linhadigitavel               varchar(54),
  pixcopiaecola                varchar(300)
);

-- distrato ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS motivocancelamentocontrato (
  idmotivocancelamentocontrato  integer PRIMARY KEY,
  descricao                     varchar(80) NOT NULL
);

CREATE TABLE IF NOT EXISTS cancelamento (
  idcancelamento                integer PRIMARY KEY,
  idcontrato                    integer NOT NULL REFERENCES contrato (idcontrato),
  idmotivocancelamentocontrato  integer NOT NULL
    REFERENCES motivocancelamentocontrato (idmotivocancelamentocontrato),
  statuscancelamento            varchar(30) NOT NULL, -- EMANALISE | CONCLUIDO | NEGADO
  datasolicitacao               date NOT NULL,
  valormulta                    numeric(14, 2),
  valorreembolso                numeric(14, 2)
);

-- atendimento ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS motivocontato (
  idmotivocontato  integer PRIMARY KEY,
  descricao        varchar(80) NOT NULL
);

CREATE TABLE IF NOT EXISTS ocorrenciaatendimentots (
  idocorrenciaatendimentots  integer PRIMARY KEY,
  idpessoa                   integer NOT NULL REFERENCES pessoa (idpessoa),
  idmotivocontato            integer NOT NULL REFERENCES motivocontato (idmotivocontato),
  statusocorrencia           varchar(30) NOT NULL, -- ABERTA | EMANDAMENTO | FINALIZADA
  dataabertura               date NOT NULL,
  datafinalizacao            date
);
