import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Autenticador } from '../auth.js';
import type { Consulta } from '../db.js';
import { agoraTse, instanteTse } from '../pascal.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `recepcaots/*` — o "casal", que é como o TS Explorer chama o lead (045).
 *
 * Duas coisas do fornecedor mandam no desenho e estão provadas nas fixtures:
 *
 * 1. **`setcasal` devolve string VAZIA.** Sem id, sem eco do corpo, sem campo
 *    de referência externa — exatamente como `CriarSolicitacaoReserva` na 038.
 *    Quem chama não tem como saber o que criou a não ser lendo de volta, e é
 *    por isso que `GetCasaisPorPeriodo` existe nesta spec.
 * 2. **O corpo pede o que um lead de WhatsApp não tem** (profissão, renda,
 *    veículo com modelo e ano, perfil de férias, endereço completo). O schema
 *    aceita tudo opcional: recusar o que o TSE aceita faria o adapter passar
 *    aqui e falhar lá — o erro que este serviço existe para evitar.
 *
 * O espelho não guarda veículo, perfil de férias nem endereço (LGPD, 012), e o
 * simulador não inventa: esses campos saem nulos ou zerados, com a FORMA do
 * TSE. É a mesma decisão já tomada em `cadastros.ts`.
 */

export interface RecepcaoDeps extends FastifyPluginOptions {
  readonly db: Consulta;
  readonly auth: Autenticador;
}

const recusar = (reply: FastifyReply, mensagem: string) =>
  reply.code(400).send({ Message: mensagem });

/** Rotas de escrita respondem PROSA com content-type JSON (035, §5 do guia). */
const frase = (reply: FastifyReply, texto: string): FastifyReply =>
  reply.type('application/json; charset=utf-8').send(JSON.stringify(texto));

/**
 * O corpo de `setcasal`. Só `Nome1` é exigido — todo o resto é opcional porque
 * o TSE aceita opcional, e o lead do WhatsApp preenche um punhado de campos.
 */
const SetCasalSchema = z
  .object({
    DataCadastro: z.string().nullish(),
    Nome1: z.string().min(1),
    Cpf1: z.string().nullish(),
    Nome2: z.string().nullish(),
    Cpf2: z.string().nullish(),
    Email: z.string().nullish(),
    DddMovel: z.string().nullish(),
    TelefoneMovel: z.string().nullish(),
    IdOrigemCasal: z.number().int().nullish(),
    Agendado: z.boolean().nullish(),
    DataHoraAgendamento: z.string().nullish(),
  })
  .passthrough();

interface LinhaCasal {
  readonly idcasal: number;
  readonly nome: string;
  readonly cpf: string | null;
  readonly telefone: string | null;
  readonly email: string | null;
  readonly idorigemvenda: number | null;
  readonly dataagendamento: string | null;
  readonly status: string;
  readonly datacadastro: string;
}

/**
 * A forma de `GetCasal` — 86 campos. Os que o erp_mock conhece vêm do banco; os
 * demais saem no tipo certo com valor neutro. Objeto complexo que o espelho não
 * tem (veículo, perfil de férias) sai `null`, que é valor legítimo no TSE (o
 * próprio exemplo traz `Veiculo2: null`).
 */
function casalTse(c: LinhaCasal) {
  const cadastro = instanteTse(c.datacadastro) ?? agoraTse();
  return {
    IdItem: c.idcasal,
    DataCadastro: cadastro,
    HoraInicio: cadastro,
    Agendado: c.dataagendamento !== null,
    DataHoraAgendamento: instanteTse(c.dataagendamento),
    Nome1: c.nome,
    Cpf1: (c.cpf ?? '').replace(/\D/g, ''),
    Email: c.email ?? '',
    DddMovel: '',
    TelefoneMovel: c.telefone ?? '',
    IdOrigemCasal: c.idorigemvenda ?? 0,
    HoraFim: null,
    IdPromotorMarketing: 0,
    IdPromotorTelemarketing: 0,
    IdLocalCaptacao: 0,
    IdGerenteSala: null,
    Compareceu: false,
    LocalHospedagem: '',
    DataCheckIn: null,
    DataCheckOut: null,
    NumeroApto: null,
    Foto1: null,
    Foto1Bin: null,
    Idade1: 0,
    DataNascimento1: null,
    IdNacionalidade1: 0,
    Veiculo1: null,
    IdProfissao1: 0,
    Aposentado1: false,
    ObsProfissao1: '',
    Foto2: null,
    Nome2: '',
    Idade2: null,
    DataNascimento2: null,
    IdNacionalidade2: 0,
    Veiculo2: null,
    IdProfissao2: 0,
    Aposentado2: false,
    ObsProfissao2: '',
    Cpf2: '',
    IdTipoRelacionamento: 0,
    TipoRelacionamentoSysId: '',
    TempoRelacionamentoAnos: 0,
    TempoRelacionamentoMeses: null,
    TempoRelacionamentoDias: null,
    QtdFilhos: null,
    NomeFilhos: '',
    QtdAcompanhantes: 0,
    NomeAcompanhantes: '',
    CartoesCreditoLista: [],
    UsuariosCheque: false,
    RendaFamiliar: 0,
    TituloFerias: '',
    QtdVezesCidade: 0,
    BrindesOferecidos: '',
    PossuiResidenciaPropria: false,
    IdTipoResidencia: 0,
    PossuiImovelNaCidade: false,
    Cep: '',
    IdCidade: 0,
    IdUf: 0,
    IdPais: 0,
    Logradouro: '',
    Complemento: '',
    Bairro: '',
    DddResidencial: '',
    TelefoneResidencial: '',
    Automovel1: null,
    Automovel2: null,
    OrigemCasalMaling: null,
    IdMotivoQualificacao: 0,
    QualificacaoDescricao: '',
    QualificacaoCategoria: '',
    QualificacaoCategoriaNormatizada: '',
    QualificacaoAtivo: false,
    PerfilDeFerias: null,
    CaminhoFoto1: null,
    CaminhoFoto2: null,
    Base64Foto1: null,
    Base64Foto2: null,
    DddFoneComercial: null,
    FoneComercial: null,
    DddFoneMovel2: null,
    FoneMovel2: null,
    ConheceEmpreendimento: false,
    Observacao: '',
  };
}

/**
 * As datas saem do SQL já no formato do TSE (mesmo padrão de
 * `painel-do-cliente.ts`): `instanteTse` só acrescenta o offset. Converter em
 * JS com `toISOString()` produziria `…Z-03:00`, que não é data nenhuma — foi
 * exatamente o que o teste de forma pegou.
 */
const COLUNAS = `idcasal, nome, cpf, telefone, email, idorigemvenda, status,
                 to_char(dataagendamento AT TIME ZONE 'America/Sao_Paulo',
                         'YYYY-MM-DD"T"HH24:MI:SS') AS dataagendamento,
                 to_char(datacadastro AT TIME ZONE 'America/Sao_Paulo',
                         'YYYY-MM-DD"T"HH24:MI:SS') AS datacadastro`;

export function recepcaoRoutes(app: FastifyInstance, opts: RecepcaoDeps, done: () => void): void {
  exigirBearer(app, opts.auth);

  /**
   * `setcasal/0` — o `0` no path é do fornecedor (id do item, 0 = novo). Devolve
   * **string vazia**: quem precisa do id lê de volta por `GetCasaisPorPeriodo`.
   */
  app.post('/api/recepcaots/setcasal/:id', async (req, reply) => {
    const c = SetCasalSchema.parse(req.body);
    const digitos = (c.Cpf1 ?? '').replace(/\D/g, '');
    await opts.db.buscar(
      `INSERT INTO tse_sim.casal
         (nome, cpf, telefone, email, idorigemvenda, dataagendamento, status, datacadastro)
       VALUES (:nome, :cpf, :telefone, :email, :origem, :agendamento::timestamptz,
               :status, coalesce(:cadastro::timestamptz, now()))`,
      {
        nome: c.Nome1,
        cpf: digitos === '' ? null : digitos,
        telefone: `${c.DddMovel ?? ''}${c.TelefoneMovel ?? ''}` || null,
        email: c.Email ?? null,
        origem: c.IdOrigemCasal ?? null,
        agendamento: c.DataHoraAgendamento ?? null,
        status: c.Agendado === true ? 'AGENDADO' : 'NOVO',
        cadastro: c.DataCadastro ?? null,
      },
    );
    return frase(reply, '');
  });

  app.get<{ Params: { idCasal: string } }>(
    '/api/recepcaots/GetCasal/:idCasal',
    async (req, reply) => {
      const [c] = await opts.db.buscar<LinhaCasal>(
        `SELECT ${COLUNAS} FROM tse_sim.casal WHERE idcasal = :id`,
        { id: Number(req.params.idCasal) },
      );
      if (!c) return recusar(reply, 'Casal não encontrado.');
      return casalTse(c);
    },
  );

  /**
   * `GetCasaisPorPeriodo` — a leitura que torna `setcasal` utilizável. O
   * adapter grava e relê por aqui para descobrir o `IdCasal` que o POST não deu.
   * Datas são o dia inteiro: `dataFinal` inclui o próprio dia.
   */
  app.get<{
    Querystring: {
      dataInicial?: string;
      dataFinal?: string;
      idUnidadeNegocio?: string;
      somenteAgendados?: string;
    };
  }>('/api/recepcaots/GetCasaisPorPeriodo', async (req) => {
    const q = req.query;
    const linhas = await opts.db.buscar<LinhaCasal>(
      `SELECT ${COLUNAS} FROM tse_sim.casal
        WHERE (:inicial::date IS NULL OR datacadastro >= :inicial::date)
          AND (:final::date IS NULL OR datacadastro < (:final::date + 1))
          AND (:agendados::boolean IS NOT TRUE OR status = 'AGENDADO')
        ORDER BY idcasal`,
      {
        inicial: q.dataInicial ?? null,
        final: q.dataFinal ?? null,
        agendados: q.somenteAgendados === 'true',
      },
    );
    return linhas.map(casalTse);
  });

  done();
}
