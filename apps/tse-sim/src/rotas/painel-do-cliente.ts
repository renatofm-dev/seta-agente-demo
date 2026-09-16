import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Autenticador, Sessao } from '../auth.js';
import type { Consulta } from '../db.js';
import { agoraTse, dataTse, decimal, diasEntre, hojeTse, instanteTse } from '../pascal.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `PainelDoCliente/*` — a área logada do cotista no TS Explorer (035).
 *
 * É aqui que mora a D10: no exemplo do fornecedor o token é de `TSE.INTEGRACAO`
 * e `MeusContratos` devolve o contrato DESSE usuário. Se o painel resolver
 * escopo pelo dono do token, um agente que atende N cotistas com UMA credencial
 * não consegue ler o financeiro de ninguém — e a 037 morre. Enquanto o
 * fornecedor não responde, `TSE_SIM_PAINEL_ESCOPO` exercita os dois mundos.
 */

/** O TSE pagina de 10 em 10 (deduzido do exemplo: 4 páginas sobre 10 itens). */
const POR_PAGINA = 10;

const ParamsContrato = z.object({
  idContrato: z.coerce.number().int().positive(),
  paginaAtual: z.coerce.number().int().min(1).default(1),
});

interface LinhaParcela {
  readonly idcontafinanceira: number;
  readonly idcontrato: number;
  readonly numeroparcela: number;
  readonly qtdparcelas: number;
  readonly valorreceber: string;
  readonly valorrecebido: string | null;
  readonly datavencimento: string;
  readonly datavencimentorecorrencia: string | null;
  readonly datarecebimento: string | null;
  readonly tipohistorico: string;
  readonly linhadigitavel: string | null;
  readonly idtipoorigemcontafinanceira: number;
  readonly idmeiopagamento: number;
  readonly datavenda: string;
}

const MEIO = {
  1: { descricao: 'BOLETO BANCÁRIO', codigo: 'BOLETO', texto: 'Boleto' },
  2: { descricao: 'PIX', codigo: 'PIX', texto: 'Pix' },
  3: { descricao: 'CREDITO PARA LINK', codigo: 'CARTAO', texto: 'Cartão' },
} as const;

/**
 * Uma parcela do erp_mock no dialeto do TSE. Os campos que o mock não tem
 * (juros, multa, correção monetária, centro de custo) saem zerados — o TSE os
 * devolve zerados quando não há cobrança acessória, que é o caso da demo.
 */
function parcelaTse(p: LinhaParcela): Record<string, unknown> {
  const hoje = hojeTse();
  const vencimento = p.datavencimentorecorrencia ?? p.datavencimento;
  const pago = p.datarecebimento !== null;
  const atraso = pago ? 0 : Math.max(0, diasEntre(vencimento, hoje));
  const valor = decimal(p.valorreceber);
  const meio = MEIO[p.idmeiopagamento as 1 | 2 | 3] ?? MEIO[1];
  const entrada = p.idtipoorigemcontafinanceira === 1;
  return {
    Identificador: p.idcontafinanceira,
    IdContrato: p.idcontrato,
    Historico: '',
    NumeroDocumento: String(p.idcontafinanceira).padStart(10, '0'),
    DataLancamento: dataTse(p.datavenda),
    DataVencimento: dataTse(p.datavencimento),
    DataVencimentoOriginal: null,
    DataVencimentoRecorrencia: dataTse(p.datavencimentorecorrencia),
    TipoParcela: entrada ? 0 : 1,
    TipoParcelaDescricao: entrada ? 'ENTRADA' : 'SALDO',
    TipoParcelaSysId: null,
    TipoParcelaBind: entrada ? 'Entrada' : 'Parcela',
    ValorParcela: valor,
    ValorReceber: valor,
    ValorAcrescimoJurosEMulta: 0,
    ValorDesconto: 0,
    ValorDescontoManual: 0,
    ValorLiquido: 0,
    ValorCorrecao: 0,
    ValorAcrescimo: 0,
    ValorJuros: 0,
    ValorJurosFinanc: null,
    ValorMulta: 0,
    TaxaBoleto: null,
    RetidoComoMulta: false,
    ValorRetidoComoMulta: 0,
    ValorPrevistoReceberLiquido: valor,
    ValorParcelaComCorrecaoMonetaria: valor,
    ValorTaxaCartao: 0,
    Pago: pago,
    DestinoContaFinanceira: 'R',
    StatusParcela: p.tipohistorico,
    DataPagamento: dataTse(p.datarecebimento),
    DataLiquidacao: dataTse(p.datarecebimento),
    MeioPagamento: p.idmeiopagamento,
    MeioPagamentoDescricao: meio.descricao,
    MeioPagamentoCodigo: meio.codigo,
    MeioPagamentoId: p.idmeiopagamento,
    MeioPagamentoTexto: meio.texto,
    DataConsultaSistema: agoraTse(),
    Vencido: atraso > 0,
    NoVencimento: !pago && vencimento === hoje,
    QtdDiasVencido: atraso,
    NroParcela: p.numeroparcela,
    NossoNumeroBoletoCalculado: p.linhadigitavel
      ? `14${String(p.idcontafinanceira).padStart(15, '0')}-9`
      : null,
    LinhaDigitavelBoleto: p.linhadigitavel,
    CodigoBarrasBoleto: p.linhadigitavel ? p.linhadigitavel.slice(0, 44) : null,
    RecorrenciaAutorizada: p.idmeiopagamento === 3,
    RetidoComoMultaDeCancelamento: false,
    ValorRetidoComoMultaCancelamento: 0,
    ExisteBoletoGerado: p.linhadigitavel !== null,
    DataProcessamento: null,
  };
}

const SQL_PARCELAS = `
  SELECT cf.idcontafinanceira, cf.idcontrato, cf.numeroparcela, cf.qtdparcelas,
         cf.valorreceber, cf.valorrecebido, cf.tipohistorico, cf.linhadigitavel,
         cf.idtipoorigemcontafinanceira, cf.idmeiopagamento,
         to_char(cf.datavencimento, 'YYYY-MM-DD')              AS datavencimento,
         to_char(cf.datavencimentorecorrencia, 'YYYY-MM-DD')   AS datavencimentorecorrencia,
         to_char(cf.datarecebimento, 'YYYY-MM-DD')             AS datarecebimento,
         to_char(c.datavenda, 'YYYY-MM-DD')                    AS datavenda
  FROM contafinanceira cf
  JOIN contrato c ON c.idcontrato = cf.idcontrato
  WHERE cf.idcontrato = :idContrato`;

/** Envelope paginado do TSE: a página em `ListaDados`, os agregados sobre o contrato inteiro. */
function paginar(todas: readonly LinhaParcela[], pagina: number): Record<string, unknown> {
  const hoje = hojeTse();
  const inicio = (pagina - 1) * POR_PAGINA;
  const vencimentoDe = (p: LinhaParcela) => p.datavencimentorecorrencia ?? p.datavencimento;
  return {
    ListaDados: todas.slice(inicio, inicio + POR_PAGINA).map(parcelaTse),
    TotalPaginas: Math.max(1, Math.ceil(todas.length / POR_PAGINA)),
    QtdParcelasNoVencimento: todas.filter((p) => !p.datarecebimento && vencimentoDe(p) === hoje)
      .length,
    QtdParcelasEmAtraso: todas.filter((p) => !p.datarecebimento && vencimentoDe(p) < hoje).length,
    QtdParcelasPagas: todas.filter((p) => p.datarecebimento !== null).length,
    QtdParcelasTotal: todas.length,
  };
}

export interface PainelDeps extends FastifyPluginOptions {
  readonly db: Consulta;
  readonly auth: Autenticador;
  readonly escopo: 'qualquer' | 'token';
}

export function painelDoClienteRoutes(
  app: FastifyInstance,
  opts: PainelDeps,
  done: () => void,
): void {
  exigirBearer(app, opts.auth);

  /** Escopo `token`: o painel só enxerga o que é do dono do token (o cenário ruim da D10). */
  async function contratoVisivel(sessao: Sessao, idContrato: number): Promise<boolean> {
    if (opts.escopo === 'qualquer') return true;
    const [linha] = await opts.db.buscar<{ idpessoatitular: number }>(
      'SELECT idpessoatitular FROM contrato WHERE idcontrato = :idContrato',
      { idContrato },
    );
    return linha !== undefined && linha.idpessoatitular === sessao.idPessoa;
  }

  app.get('/api/PainelDoCliente/MeusContratos', async (req) => {
    // token sem pessoa vinculada no escopo `token`: não há "meus contratos" —
    // devolver a base inteira aqui seria justamente o contrário do que este modo
    // existe para simular
    if (opts.escopo === 'token' && req.sessao.idPessoa === null) return [];
    const so = opts.escopo === 'token' ? req.sessao.idPessoa : null;
    return opts.db
      .buscar<Record<string, unknown>>(
        `SELECT c.idcontrato, c.numerocontrato, c.statuscontrato, c.qtdpontos, q.idgrupocota,
                p.nome AS titular, g.nome AS tier, m.nome AS modelo,
                to_char(c.datavenda, 'YYYY-MM-DD') AS datavenda,
                -- vigência de multipropriedade; em SQL porque somar 30 anos na
                -- string quebra em 29/02 (e o Postgres sabe o que fazer com isso)
                to_char(c.datavenda + interval '30 years', 'YYYY-MM-DD') AS fimvigencia,
                (SELECT coalesce(sum(valorreceber), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO')      AS negociado,
                (SELECT coalesce(sum(valorreceber), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO'
                    AND f.idtipoorigemcontafinanceira = 1)                              AS entrada,
                (SELECT coalesce(sum(coalesce(valorrecebido, 0)), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO')      AS integralizado,
                (SELECT coalesce(sum(valorreceber), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO'
                    AND f.datarecebimento IS NULL)                                      AS restante,
                (SELECT coalesce(sum(valorreceber), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO'
                    AND f.datarecebimento IS NULL
                    AND coalesce(f.datavencimentorecorrencia, f.datavencimento) < current_date)
                                                                                        AS atraso,
                (SELECT count(*) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO'
                    AND f.datarecebimento IS NULL
                    AND coalesce(f.datavencimentorecorrencia, f.datavencimento) < current_date)
                                                                                        AS qtdvencidas,
                -- só parcela EM ATRASO conta: sem o filtro, um contrato em dia
                -- devolve dias negativos (a próxima parcela ainda vai vencer)
                (SELECT coalesce(max(current_date
                          - coalesce(f.datavencimentorecorrencia, f.datavencimento))
                          FILTER (WHERE coalesce(f.datavencimentorecorrencia, f.datavencimento)
                                        < current_date), 0)
                   FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO'
                    AND f.datarecebimento IS NULL)                                      AS diasvencido
           FROM contrato c
           JOIN pessoa p    ON p.idpessoa = c.idpessoatitular
           JOIN cotauh q    ON q.idcotauh = coalesce(c.idcotaativa, c.idcotaadquirida)
           JOIN grupocota g ON g.idgrupocota = q.idgrupocota
           JOIN modelocota m ON m.idmodelocota = q.idmodelocota
          WHERE (:idPessoa::int IS NULL OR c.idpessoatitular = :idPessoa)
          ORDER BY c.idcontrato`,
        { idPessoa: so },
      )
      .then((linhas) =>
        linhas.map((c) => {
          const negociado = decimal(c.negociado as string);
          const integralizado = decimal(c.integralizado as string);
          const percentual = negociado > 0 ? Math.round((integralizado / negociado) * 100) : 0;
          return {
            IdContrato: c.idcontrato,
            NumeroContrato: c.numerocontrato,
            DescricaoProduto: `${c.tier} - ${c.modelo}`,
            QtdPontosContratados: c.qtdpontos,
            PercentualMinimoIntegralizadoExigido: 0,
            QtdPontosDebitados: 0,
            QtdPontosUtilizados: 0,
            QtdPontosCompraAvulsa: 0,
            QtdPontosDebitarPorNaoUtilizacao: 0,
            QtdPontosDebitadosPorNaoUtilizacao: 0,
            QtdTotalPontosDebitadosPorNaoUtilizacao: 0,
            DataVenda: dataTse(c.datavenda as string),
            DataEfetivacaoDebitoPorNaoutilizacao: null,
            ValorNegociado: negociado,
            ValorTotalEntrada: decimal(c.entrada as string),
            ValorTotalSaldoRestante: decimal(c.restante as string),
            PorcentagemIntegralizadaSobreValorNegociado: percentual,
            NomeCessionario: c.titular,
            QtdPontosLiberadosParaUso: c.qtdpontos,
            QtdParcelasVencidas: Number(c.qtdvencidas),
            QtdDiasVencido: Number(c.diasvencido),
            ProximaUtilizacao: null,
            IdGrupoTabelaPontos: c.idgrupocota,
            IdEmpresa: 1,
            DataInicioVigencia: dataTse(c.datavenda as string),
            DataFimVigencia: dataTse(c.fimvigencia as string),
            ValorTotalIntegralizado: integralizado,
            ValorTotalEmAtraso: decimal(c.atraso as string),
            PorcentagemAIntegralizarSobreValorNegociado: 100 - percentual,
            TipoContrato: 'COTA',
            StatusContrato: c.statuscontrato,
            SaldoPontosGeral: 0,
          };
        }),
      );
  });

  app.get('/api/PainelDoCliente/MeusDadosCadastrais', async (req) => {
    const [pessoa] = await opts.db.buscar<{ nome: string; cpf: string; email: string | null }>(
      'SELECT nome, cpf, email FROM pessoa WHERE idpessoa = :idPessoa',
      { idPessoa: req.sessao.idPessoa },
    );
    return {
      DataCadastro: agoraTse(),
      DataAlteracao: null,
      TipoPessoa: 0,
      RazaoSocial: pessoa?.nome ?? '',
      NomeFantasia: '',
      DataNascimento: null,
      CpfCnpj: pessoa?.cpf.replace(/\D/g, '') ?? '',
      RgInscricaoEstadual: '',
      InscricaoEstadual: '',
      InscricaoMunicipal: '',
      OrgaoExpedidorCi: '',
      UfCi: '',
      DataEmissaoCi: null,
      PisPasep: '',
      TituloEleitor: '',
      Ctps: '',
      IdProfissao: 0,
      Profissao: '',
      Sexo: 0,
      EstadoCivilId: 0,
      EstadoCivilDescricao: '',
      RegimeCasamentoId: 0,
      RegimeCasamentoDescricao: '',
      // o erp_mock da 012 não replica telefone nem endereço: o espelho real teve
      // SELECT revogado nessas colunas por LGPD, e o mock nasceu dentro da mesma
      // fronteira. Listas vazias são a resposta honesta — não dado inventado.
      ContatosTelefonicos: [],
      EnderecosEmail: pessoa?.email
        ? [{ IdEnderecoEmail: 0, Descricao: '', Email: pessoa.email }]
        : [],
      EnderecosCorrespondencia: [],
      CpfCnpjFormatado: pessoa?.cpf ?? '',
      IdIdioma: 6,
      Idioma: 'PT',
      IdNacionalidade: 30,
      Nacionalidade: 'Brasil',
      SiglaNacionalidade: 'BRA',
    };
  });

  app.get('/api/PainelDoCliente/FinanceiroContrato', async (req) => {
    const { idContrato, paginaAtual } = ParamsContrato.parse(req.query);
    if (!(await contratoVisivel(req.sessao, idContrato))) return paginar([], paginaAtual);
    const parcelas = await opts.db.buscar<LinhaParcela>(
      `${SQL_PARCELAS} ORDER BY cf.idtipoorigemcontafinanceira, cf.numeroparcela`,
      { idContrato },
    );
    return paginar(parcelas, paginaAtual);
  });

  app.get('/api/PainelDoCliente/MeusBoletos', async (req) => {
    const { idContrato, paginaAtual } = ParamsContrato.parse(req.query);
    if (!(await contratoVisivel(req.sessao, idContrato))) return paginar([], paginaAtual);
    const parcelas = await opts.db.buscar<LinhaParcela>(
      `${SQL_PARCELAS} AND cf.linhadigitavel IS NOT NULL
         ORDER BY cf.idtipoorigemcontafinanceira, cf.numeroparcela`,
      { idContrato },
    );
    return paginar(parcelas, paginaAtual);
  });

  // --- reserva (038): o que o cotista vê da própria utilização -----------------

  app.get<{ Params: { idContrato: string } }>(
    '/api/PainelDoCliente/HoteisDisponiveisUso/:idContrato',
    async () =>
      (
        await opts.db.buscar<{ idedificiohotel: number; nome: string }>(
          'SELECT idedificiohotel, nome FROM edificiohotel ORDER BY idedificiohotel',
        )
      ).map((h) => ({ IdEdificioHotel: h.idedificiohotel, Descricao: h.nome })),
  );

  app.get<{ Params: { idEdificioHotel: string } }>(
    '/api/PainelDoCliente/TiposUnidadeHoteleira/:idEdificioHotel',
    async (req) =>
      (
        await opts.db.buscar<{ idtipounidadehoteleira: number; nome: string }>(
          `SELECT DISTINCT t.idtipounidadehoteleira, t.nome
             FROM unidadehoteleira u
             JOIN tse_sim.tipounidadehoteleira t ON t.capacidade = u.capacidade
            WHERE u.idedificiohotel = :idEdificio
            ORDER BY t.idtipounidadehoteleira`,
          { idEdificio: Number(req.params.idEdificioHotel) },
        )
      ).map((t) => ({ IdTipoUnidadeHoteleira: t.idtipounidadehoteleira, Descricao: t.nome })),
  );

  /**
   * `CriarSolicitacaoReserva` devolve **200 com corpo vazio** — é assim na
   * coleção do fornecedor, e é exatamente por isso que a jornada da 038 NÃO usa
   * esta rota: sem id não há como confirmar nem cancelar. Ela existe aqui para
   * que o contrato fique documentado e ninguém tente este caminho de novo.
   */
  app.get('/api/PainelDoCliente/CriarSolicitacaoReserva', async (_req, reply) =>
    reply.type('application/json; charset=utf-8').send('""'),
  );

  app.get('/api/PainelDoCliente/MinhasUtilizacoesContrato', async (req) => {
    const { idContrato, paginaAtual } = ParamsContrato.parse(req.query);
    const [contrato] = await opts.db.buscar<{ qtdpontos: number; titular: string }>(
      `SELECT c.qtdpontos, p.nome AS titular FROM contrato c
         JOIN pessoa p ON p.idpessoa = c.idpessoatitular
        WHERE c.idcontrato = :idContrato`,
      { idContrato },
    );
    const linhas = await opts.db.buscar<Record<string, unknown>>(
      `SELECT u.idutilizacao, u.status, u.qtdpontosdebitados, u.qtdadultos, u.qtdcriancas,
              u.qtdpagantes, u.idedificiohotel, u.idtipounidadehoteleira,
              e.nome AS hotel, t.nome AS tipouh, o.nome AS operador,
              to_char(u.datacheckin, 'YYYY-MM-DD')  AS checkin,
              to_char(u.datacheckout, 'YYYY-MM-DD') AS checkout,
              to_char(u.datacriacao AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') AS criada
         FROM tse_sim.utilizacaocontrato u
         LEFT JOIN edificiohotel e ON e.idedificiohotel = u.idedificiohotel
         LEFT JOIN tse_sim.tipounidadehoteleira t ON t.idtipounidadehoteleira = u.idtipounidadehoteleira
         LEFT JOIN tse_sim.operador o ON o.idoperador = u.idoperador
        WHERE u.idcontrato = :idContrato
        ORDER BY u.idutilizacao DESC`,
      { idContrato },
    );
    const debitados = linhas
      .filter((u) => u.status !== 'CANCELADA')
      .reduce((acc, u) => acc + Number(u.qtdpontosdebitados), 0);
    const pagina = linhas.slice((paginaAtual - 1) * POR_PAGINA, paginaAtual * POR_PAGINA);
    const contratados = Number(contrato?.qtdpontos ?? 0);
    return {
      QtdPontosContratados: contratados,
      PercentualIntegralizado: 0,
      PercentualMinimoIntegralizadoExigido: 0,
      QtdPontosDebitados: debitados,
      QtdPontosUtilizados: debitados,
      QtdPontosCompraAvulsa: 0,
      QtdPontosLiberadoUso: contratados - debitados,
      QtdPontosDebitarPorNaoUtilizacao: 0,
      DataEfetivacaoDebitoPorNaoutilizacao: null,
      TotalPaginas: Math.max(1, Math.ceil(linhas.length / POR_PAGINA)),
      SaldoPontosGeral: contratados - debitados,
      Utilizacoes: pagina.map((u) => ({
        IdUtilizacaoContrato: u.idutilizacao,
        DataCadastro: instanteTse(u.criada as string),
        DataAlteracao: null,
        IdContrato: idContrato,
        IdContratoIntercambio: 0,
        ContratoIntercambio: null,
        DataSolicitacao: instanteTse(u.criada as string),
        // o rastro que separa robô de humano: quem pediu a reserva
        IdOperadorRespSolicitacao: 0,
        OperadorRespSolicitacao: u.operador ?? null,
        IdPessoaSolicitante: 0,
        PessoaSolicitante: contrato?.titular ?? '',
        NomeSolicitante: contrato?.titular ?? '',
        DataCheckIn: dataTse(u.checkin as string),
        DataCheckOut: dataTse(u.checkout as string),
        NroNoites: diasEntre(u.checkin as string, u.checkout as string),
        IdTipoUtilizacaoContrato: 1,
        TipoUtilizacaoContrato: 'Reserva',
        Convidados: null,
        SemanaDoAno: 0,
        IdHotelReserva: u.idedificiohotel,
        HotelReserva: u.hotel ?? '',
        IdUh: 0,
        Uh: '',
        Cortesia: false,
        IdentificadorCortesia: '',
        CustoPontos: Number(u.qtdpontosdebitados),
        QtdPontosAcrescimo: 0,
        QtdPontosDesconto: 0,
        CustoTotalPontos: Number(u.qtdpontosdebitados),
        PoderIntercambio: 0,
        NroReserva: Number(u.idutilizacao),
        QtdPagantes: Number(u.qtdpagantes),
        IdTipoUhTarifas: u.idtipounidadehoteleira,
        TipoUhTarifas: u.tipouh ?? '',
        QtdAdultos: Number(u.qtdadultos),
        QtdCriancas: Number(u.qtdcriancas),
        QtdBebes: 0,
        UtilizacaoConfirmada: u.status === 'CONFIRMADA',
        DataConfirmacao: null,
        IdRespConfirmacao: 0,
        RespConfirmacao: null,
        DataCancelamento: null,
        IdRespCancelamento: 0,
        RespCancelamento: null,
        MotivoCancelamento: null,
        Status: u.status,
        Observacao: '',
        IdOperadorCadastro: 0,
        RespCadastro: (u.operador as string) ?? '',
        IdOperadorAlteracao: 0,
        RespAlteracao: '',
        Hospedes: [],
      })),
    };
  });

  /**
   * Taxa de não utilização (DPNU). O erp_mock não modela DPNU — nenhum contrato
   * da demo tem taxa lançada —, e lista vazia é o que o TSE devolve nesse caso.
   * Inventar uma taxa aqui seria regra de negócio NOSSA dentro do dublê.
   */
  app.get<{ Params: { idContrato: string } }>(
    '/api/PainelDoCliente/ObterTaxasDPNU/:idContrato',
    async () => [],
  );

  done();
}
