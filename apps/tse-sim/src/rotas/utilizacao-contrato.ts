import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Autenticador } from '../auth.js';
import type { Banco, Consulta } from '../db.js';
import { dataTse, decimal, instanteTse } from '../pascal.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `utilizacaocontrato/*` — o ciclo da RESERVA no TS Explorer (038).
 *
 * Por que o caminho de operador e não o do painel do cliente:
 * `PainelDoCliente/CriarSolicitacaoReserva` devolve **200 com corpo vazio** — sem
 * id não há como confirmar nem cancelar. Quem quiser levar uma reserva até o fim
 * usa `CriarUtilizacaoContrato` → `IdUtilizacaoContrato` →
 * `ConfirmarUtilizacaoContrato/{id}`. Ou seja: **o agente age como operador**, e
 * o TSE registra isso em `IdOperadorRespSolicitacao` (é o que separa, na
 * auditoria, a reserva feita pelo robô da feita por um atendente).
 *
 * A escrita são DUAS chamadas, não N+2: `CriarUtilizacaoContrato` aceita
 * `ListaHospedes` inline, então criar+hóspedes é uma coisa só.
 */

export interface UtilizacaoDeps extends FastifyPluginOptions {
  readonly db: Banco;
  readonly auth: Autenticador;
}

/** O TSE não tem exemplo de erro na coleção; o envelope é o padrão do ASP.NET. */
const recusar = (reply: FastifyReply, mensagem: string) =>
  reply.code(400).send({ Message: mensagem });

/** Rotas de escrita respondem PROSA com content-type JSON (035, §5 do guia). */
const frase = (reply: FastifyReply, texto: string): FastifyReply =>
  reply.type('application/json; charset=utf-8').send(JSON.stringify(texto));

/**
 * Faixas etárias: lista fixa do produto do fornecedor, sem origem no erp_mock.
 * Copiadas da fixture — inventar outras faria o adapter passar aqui e falhar lá.
 */
const FAIXAS_ETARIAS = [
  { IdFaixaEtaria: 1, Descricao: 'Adulto', Sigla: 'ADT', Pagante: true },
  { IdFaixaEtaria: 2, Descricao: 'Criança 1', Sigla: 'CH1', Pagante: true },
  { IdFaixaEtaria: 3, Descricao: 'Criança 2', Sigla: 'CH2', Pagante: false },
] as const;

const SimulacaoQuery = z.object({
  IdContrato: z.coerce.number().int().positive(),
  IdHotel: z.coerce.number().int().positive(),
  IdTipoUh: z.coerce.number().int().positive(),
  DataInicial: z.string().min(10),
  DataFinal: z.string().min(10),
  qtdpagantespontos: z.coerce.number().int().min(1).max(20).default(1),
});

const HospedeSchema = z.object({
  Nome: z.string().min(1).max(120),
  Sobrenome: z.string().max(120).nullish(),
  Cpf: z.string().max(14).nullish(),
  IdFaixaEtaria: z.number().int().positive().default(1),
  HospedePrincipal: z.boolean().default(false),
  Sexo: z.string().max(20).nullish(),
});

const CriarSchema = z.object({
  IdContrato: z.number().int().positive(),
  IdHotel: z.number().int().positive(),
  IdTipoUh: z.number().int().positive(),
  DataInicial: z.string().min(10),
  DataFinal: z.string().min(10),
  QtdAdultos: z.number().int().min(0).default(1),
  QtdCriancas: z.number().int().min(0).default(0),
  TipoUtilizacao: z.string().default('RESERVA'),
  ListaHospedes: z.array(HospedeSchema).default([]),
});

/** `YYYY-MM-DD` de uma data do TSE, que pode vir com hora e offset. */
const dia = (texto: string): string => texto.slice(0, 10);

/** Diárias do período: check-in incluído, check-out não (é a noite que conta). */
function diarias(inicial: string, final: string): string[] {
  const saida: string[] = [];
  for (
    let t = Date.parse(`${dia(inicial)}T00:00:00Z`);
    t < Date.parse(`${dia(final)}T00:00:00Z`);
    t += 86_400_000
  ) {
    saida.push(new Date(t).toISOString().slice(0, 10));
    if (saida.length > 90) break; // guarda: período absurdo não vira varredura
  }
  return saida;
}

interface LinhaTarifa {
  readonly periodo: string;
  readonly pontospordiaria: number;
  readonly taxacentavos: string;
  readonly bloqueado: boolean;
  readonly mes: number;
}

/**
 * Tarifa de cada diária. O custo em pontos NÃO é multiplicado por
 * `qtdpagantespontos`: a tabela é por unidade/diária, e o simulador não inventa
 * regra de negócio que a coleção não mostra.
 */
async function tarifasDoPeriodo(
  db: Consulta,
  idTipoUh: number,
  dias: readonly string[],
): Promise<Map<string, LinhaTarifa>> {
  const linhas = await db.buscar<LinhaTarifa>(
    `SELECT periodo, pontospordiaria, taxacentavos::text AS taxacentavos, bloqueado,
            unnest(meses) AS mes
       FROM tse_sim.tarifapontos
      WHERE idtipounidadehoteleira = :idTipoUh`,
    { idTipoUh },
  );
  const porMes = new Map<number, LinhaTarifa>(linhas.map((l) => [Number(l.mes), l]));
  const saida = new Map<string, LinhaTarifa>();
  for (const d of dias) {
    const t = porMes.get(Number(d.slice(5, 7)));
    if (t) saida.set(d, t);
  }
  return saida;
}

/**
 * `CriarUtilizacaoContrato` e `ObterDadosUtilizacaoContrato` devolvem **o mesmo
 * conjunto de chaves** na coleção do fornecedor — conferido fixture a fixture.
 * Um mapeador só, então, para os dois não divergirem com o tempo.
 */
const SQL_UTILIZACAO = `
  SELECT u.idutilizacao, u.status, u.qtdpontosdebitados, u.taxacentavos::text AS taxacentavos,
         u.qtdadultos, u.qtdcriancas, e.nome AS hotel, t.nome AS tipouh,
         to_char(u.datacheckin, 'YYYY-MM-DD')  AS checkin,
         to_char(u.datacheckout, 'YYYY-MM-DD') AS checkout,
         (SELECT count(*) FROM tse_sim.hospede h WHERE h.idutilizacao = u.idutilizacao) AS hospedes
    FROM tse_sim.utilizacaocontrato u
    LEFT JOIN edificiohotel e ON e.idedificiohotel = u.idedificiohotel
    LEFT JOIN tse_sim.tipounidadehoteleira t ON t.idtipounidadehoteleira = u.idtipounidadehoteleira
   WHERE u.idutilizacao = :id`;

function utilizacaoTse(u: Record<string, unknown>): Record<string, unknown> {
  return {
    IdUtilizacaoContrato: u.idutilizacao,
    Status: u.status,
    CustoTotalPontos: Number(u.qtdpontosdebitados),
    ValorTotalTaxaManutencao: Number(u.taxacentavos) / 100,
    DataCheckIn: dataTse(u.checkin as string),
    DataCheckOut: dataTse(u.checkout as string),
    HotelReservaDescricao: u.hotel,
    TipoUhDescricao: u.tipouh,
    QtdAdultos: Number(u.qtdadultos),
    QtdCriancas: Number(u.qtdcriancas),
    QtdHospedes: Number(u.hospedes),
    // o mock não modela cortesia, pensão, fracionamento nem block/market code;
    // as chaves existem porque o TSE as devolve, e sumir com elas faria o adapter
    // passar aqui e quebrar lá
    Cortesia: false,
    CreditoFracionamento: null,
    DebitoFracionamento: null,
    DescricaoBlockCode: null,
    DescricaoMarketCode: null,
    DescricaoTipoPensao1: null,
    DescricaoTipoPensao2: null,
    DescricaoTipoPensao3: null,
    IdBlockCode: null,
    IdMarketCode: null,
    QtdTotalPontosPagamentoPensao: 0,
    TaxasManutencao: null,
    TaxasPensao: null,
    ValorTaxaCancelamento: 0,
    ValorTotalPensao: 0,
    ValorTotalPensaoPagamentoCach: 0,
    ValorTotalPontosPagamentoPensao: 0,
  };
}

export function utilizacaoContratoRoutes(
  app: FastifyInstance,
  opts: UtilizacaoDeps,
  done: () => void,
): void {
  exigirBearer(app, opts.auth);

  /**
   * Como o operador acha o contrato a partir do CPF. É a leitura que NÃO passa
   * pelo painel do cliente e, por isso, a única que responde a D10 na prática:
   * se o painel resolver escopo pelo token, é por aqui que o agente ainda
   * enxerga o cotista certo.
   */
  app.get<{ Querystring: { cpf?: string } }>(
    '/api/utilizacaocontrato/obtercontratos',
    async (req) => {
      const linhas = await opts.db.buscar<Record<string, unknown>>(
        `SELECT c.idcontrato, c.numerocontrato, c.statuscontrato, c.qtdpontos,
                (SELECT coalesce(sum(valorreceber), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO') AS negociado
           FROM contrato c
           JOIN pessoa p ON p.idpessoa = c.idpessoatitular
          WHERE regexp_replace(p.cpf, '\\D', '', 'g') = regexp_replace(:cpf, '\\D', '', 'g')
          ORDER BY c.idcontrato`,
        { cpf: req.query.cpf ?? '' },
      );
      return linhas.map((c) => ({
        IdContrato: c.idcontrato,
        NumeroContrato: c.numerocontrato,
        Status: c.statuscontrato,
        QtdPontosLiberados: c.qtdpontos,
        ObrigaLancamentoPensaoUtilizacaoContrato: false,
        QtdMinimaDiariasUtilizacaoContrato: 0,
        ValorNegociado: decimal(c.negociado as string),
      }));
    },
  );

  // --- referências da reserva -------------------------------------------------

  app.get<{ Params: { idContrato: string } }>(
    '/api/utilizacaocontrato/ObterHoteis/:idContrato',
    async () =>
      (
        await opts.db.buscar<{ idedificiohotel: number; nome: string }>(
          'SELECT idedificiohotel, nome FROM edificiohotel ORDER BY idedificiohotel',
        )
      ).map((h) => ({ IdHotelNegocio: h.idedificiohotel, Descricao: h.nome })),
  );

  /** Só os tipos que existem NAQUELE prédio — o tipo vem da capacidade da UH. */
  app.get<{ Params: { idEdificioHotel: string } }>(
    '/api/utilizacaocontrato/ObterTiposUnidadeHoteleira/:idEdificioHotel',
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

  app.get('/api/utilizacaocontrato/ObterTiposFaixaEtaria', async () => FAIXAS_ETARIAS);

  app.get('/api/utilizacaocontrato/ObterTiposPensao', async () =>
    (
      await opts.db.buscar<{ idtipopensao: number; nome: string; valorcentavos: string }>(
        'SELECT idtipopensao, nome, valorcentavos::text AS valorcentavos FROM tse_sim.tipopensao ORDER BY idtipopensao',
      )
    ).map((p) => ({
      IdTipoPensaoUtilizacaoContratoTs: p.idtipopensao,
      Descricao: p.nome,
      ValorAdt: Number(p.valorcentavos) / 100,
      ValorCh1: Number(p.valorcentavos) / 200,
      ValorCh2: 0,
      ValorIds: 0,
      PercentualValorPensaoPagamentoEmPontos: 0,
    })),
  );

  // --- simulação --------------------------------------------------------------

  /**
   * DIVERGÊNCIA DA COLEÇÃO, mesma do `/token`: o fornecedor salvou esta rota como
   * **GET com body**, e o `fetch` do Node recusa body em GET. Aqui ela lê a query
   * string — o único jeito de um GET carregar os parâmetros.
   */
  app.get('/api/utilizacaocontrato/SimularUtilizacaoContrato', async (req, reply) => {
    const q = SimulacaoQuery.parse(req.query);
    const dias = diarias(q.DataInicial, q.DataFinal);
    if (dias.length === 0)
      return recusar(reply, 'Período inválido: check-out deve ser após o check-in.');
    const tarifas = await tarifasDoPeriodo(opts.db, q.IdTipoUh, dias);
    return dias.map((d) => {
      const t = tarifas.get(d);
      return {
        DataDiaria: dataTse(d),
        Bloqueado: t?.bloqueado ?? true,
        DescricaoPeriodo: t?.periodo ?? 'INDISPONÍVEL',
        CustoPorDiaria: t?.pontospordiaria ?? 0,
        ValorTaxaPeriodo: t ? Number(t.taxacentavos) / 100 : 0,
      };
    });
  });

  // --- escrita ----------------------------------------------------------------

  app.post('/api/utilizacaocontrato/CriarUtilizacaoContrato', async (req, reply) => {
    const c = CriarSchema.parse(req.body);
    const dias = diarias(c.DataInicial, c.DataFinal);
    if (dias.length === 0)
      return recusar(reply, 'Período inválido: check-out deve ser após o check-in.');

    const tarifas = await tarifasDoPeriodo(opts.db, c.IdTipoUh, dias);
    if (dias.some((d) => tarifas.get(d)?.bloqueado ?? true)) {
      return recusar(reply, 'Período bloqueado para utilização.');
    }
    const pontos = dias.reduce((acc, d) => acc + (tarifas.get(d)?.pontospordiaria ?? 0), 0);
    const taxaCentavos = dias.reduce(
      (acc, d) => acc + Number(tarifas.get(d)?.taxacentavos ?? 0),
      0,
    );

    const [saldo] = await opts.db.buscar<{ saldo: string }>(
      `SELECT (c.qtdpontos - coalesce((SELECT sum(u.qtdpontosdebitados) FROM tse_sim.utilizacaocontrato u
                                        WHERE u.idcontrato = c.idcontrato AND u.status <> 'CANCELADA'), 0))::text AS saldo
         FROM contrato c WHERE c.idcontrato = :idContrato`,
      { idContrato: c.IdContrato },
    );
    if (saldo === undefined) return recusar(reply, 'Contrato não encontrado.');
    if (Number(saldo.saldo) < pontos) {
      return recusar(
        reply,
        `Saldo de pontos insuficiente: disponível ${saldo.saldo}, necessário ${pontos}.`,
      );
    }

    const id = await opts.db.transacao(async (tx) => {
      const [nova] = await tx.buscar<{ idutilizacao: number }>(
        `INSERT INTO tse_sim.utilizacaocontrato
           (idcontrato, idedificiohotel, idtipounidadehoteleira, datacheckin, datacheckout,
            qtdpagantes, qtdadultos, qtdcriancas, qtdpontosdebitados, taxacentavos, status, idoperador)
         VALUES (:idContrato, :idHotel, :idTipoUh, :checkin::date, :checkout::date,
                 :pagantes, :adultos, :criancas, :pontos, :taxa, 'ATIVO',
                 (SELECT idoperador FROM tse_sim.operador WHERE login = :login))
         RETURNING idutilizacao`,
        {
          idContrato: c.IdContrato,
          idHotel: c.IdHotel,
          idTipoUh: c.IdTipoUh,
          checkin: dia(c.DataInicial),
          checkout: dia(c.DataFinal),
          pagantes: c.QtdAdultos + c.QtdCriancas,
          adultos: c.QtdAdultos,
          criancas: c.QtdCriancas,
          pontos,
          taxa: taxaCentavos,
          // quem está logado: é o rastro que separa robô de humano na auditoria
          login: req.sessao.login,
        },
      );
      const idUtilizacao = nova?.idutilizacao as number;
      for (const h of c.ListaHospedes) {
        await tx.buscar(
          `INSERT INTO tse_sim.hospede
             (idutilizacao, nome, sobrenome, cpf, idfaixaetaria, sexo, principal)
           VALUES (:id, :nome, :sobrenome, :cpf, :faixa, :sexo, :principal)`,
          {
            id: idUtilizacao,
            nome: h.Nome,
            sobrenome: h.Sobrenome ?? null,
            cpf: h.Cpf ?? null,
            faixa: h.IdFaixaEtaria,
            sexo: h.Sexo ?? null,
            principal: h.HospedePrincipal,
          },
        );
      }
      return idUtilizacao;
    });

    const [criada] = await opts.db.buscar<Record<string, unknown>>(SQL_UTILIZACAO, { id });
    return utilizacaoTse(criada as Record<string, unknown>);
  });

  app.post<{ Params: { id: string } }>(
    '/api/utilizacaocontrato/ConfirmarUtilizacaoContrato/:id',
    async (req, reply) => {
      const linhas = await opts.db.buscar<{ idutilizacao: number }>(
        `UPDATE tse_sim.utilizacaocontrato SET status = 'CONFIRMADA'
          WHERE idutilizacao = :id AND status = 'ATIVO' RETURNING idutilizacao`,
        { id: Number(req.params.id) },
      );
      if (linhas.length === 0) {
        return recusar(reply, 'Utilização não encontrada ou já confirmada.');
      }
      return frase(reply, 'Utilização confirmada com sucesso!');
    },
  );

  app.post('/api/utilizacaocontrato/CancelarUtilizacaoContrato', async (req, reply) => {
    const corpo = z
      .object({
        IdUtilizacaoContrato: z.number().int().positive(),
        MotivoCancelamento: z.string().max(300).nullish(),
      })
      .parse(req.body);
    const linhas = await opts.db.buscar<{ idutilizacao: number }>(
      `UPDATE tse_sim.utilizacaocontrato SET status = 'CANCELADA'
        WHERE idutilizacao = :id AND status <> 'CANCELADA' RETURNING idutilizacao`,
      { id: corpo.IdUtilizacaoContrato },
    );
    if (linhas.length === 0) return recusar(reply, 'Utilização não encontrada ou já cancelada.');
    return frase(reply, 'Utilização cancelada com sucesso');
  });

  // --- leitura de uma utilização ----------------------------------------------

  app.get<{ Params: { idUtilizacao: string } }>(
    '/api/utilizacaocontrato/ObterDadosUtilizacaoContrato/:idUtilizacao',
    async (req, reply) => {
      const [u] = await opts.db.buscar<Record<string, unknown>>(SQL_UTILIZACAO, {
        id: Number(req.params.idUtilizacao),
      });
      if (!u) return reply.code(404).send({ Message: 'Utilização não encontrada.' });
      return utilizacaoTse(u);
    },
  );

  app.get<{ Params: { idUtilizacao: string } }>(
    '/api/utilizacaocontrato/ObterHospedes/:idUtilizacao',
    async (req) =>
      (
        await opts.db.buscar<Record<string, unknown>>(
          `SELECT h.idhospede, h.nome, h.sobrenome, h.cpf, h.sexo, h.principal, h.idfaixaetaria
             FROM tse_sim.hospede h WHERE h.idutilizacao = :id ORDER BY h.idhospede`,
          { id: Number(req.params.idUtilizacao) },
        )
      ).map((h) => ({
        IdHospede: h.idhospede,
        Nome: h.nome,
        Sobrenome: h.sobrenome ?? '',
        Cpf: h.cpf ?? '',
        HospedePrincipal: h.principal,
        Sexo: h.sexo ?? '',
        FaixaEtaria:
          FAIXAS_ETARIAS.find((f) => f.IdFaixaEtaria === Number(h.idfaixaetaria))?.Descricao ?? '',
      })),
  );

  done();
}
