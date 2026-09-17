import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Autenticador } from '../auth.js';
import type { Consulta } from '../db.js';
import { agoraTse } from '../pascal.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `cadastros/*` — pessoa por id e por CPF (035). Duas formas DIFERENTES para a
 * mesma entidade, e isso é do fornecedor: `GetPessoa` devolve o cadastro
 * inteiro, `GetPessoaCpf` devolve três campos. O simulador copia a diferença.
 *
 * O erp_mock guarda nome, CPF e e-mail — nada mais. Endereço e telefone não
 * existem no espelho (SELECT revogado por LGPD na 012), então saem como lista
 * vazia: a forma do TSE, sem dado inventado.
 */

export interface CadastrosDeps extends FastifyPluginOptions {
  readonly db: Consulta;
  readonly auth: Autenticador;
}

interface LinhaPessoa {
  readonly idpessoa: number;
  readonly nome: string;
  readonly cpf: string;
  readonly email: string | null;
}

const NAO_ENCONTRADA = { Message: 'Pessoa não encontrada.' } as const;

/**
 * 045: `SetPessoa` — cria o comprador que `SetVenda` exige em `IdComprador1`.
 * Só `RazaoSocial` (o nome) e `CpfCnpj` importam para o espelho; o resto do
 * corpo do TSE (RG, estado civil, endereços, idioma) não existe no erp_mock e
 * é aceito e ignorado, pelo mesmo motivo de sempre: recusar o que o TSE aceita
 * quebraria o adapter só contra o dublê.
 *
 * Diferente das outras escritas, a resposta **não é prosa**: é o id nu
 * (`358` no exemplo do fornecedor).
 */
const SetPessoaSchema = z
  .object({
    RazaoSocial: z.string().min(1),
    CpfCnpj: z.string().min(11),
    NomeFantasia: z.string().nullish(),
  })
  .passthrough();

export function cadastrosRoutes(app: FastifyInstance, opts: CadastrosDeps, done: () => void): void {
  exigirBearer(app, opts.auth);

  /** O `0` do path é do fornecedor (id do item, 0 = nova pessoa). */
  app.post('/api/cadastros/SetPessoa/:id', async (req, reply: FastifyReply) => {
    const p = SetPessoaSchema.parse(req.body);
    const digitos = p.CpfCnpj.replace(/\D/g, '');
    // mesma pessoa não vira dois cadastros: o CPF é a chave natural do espelho,
    // e é isso que torna a escrita do adapter reprocessável sem duplicar
    const [existente] = await opts.db.buscar<{ idpessoa: number }>(
      `SELECT idpessoa FROM pessoa
        WHERE regexp_replace(cpf, '\\D', '', 'g') = :cpf`,
      { cpf: digitos },
    );
    if (existente) {
      return reply.type('application/json; charset=utf-8').send(String(existente.idpessoa));
    }
    const [nova] = await opts.db.buscar<{ idpessoa: number }>(
      `INSERT INTO pessoa (nome, cpf, email) VALUES (:nome, :cpf, NULL)
       RETURNING idpessoa`,
      { nome: p.RazaoSocial, cpf: digitos },
    );
    return reply.type('application/json; charset=utf-8').send(String(nova?.idpessoa));
  });

  app.get<{ Params: { idPessoa: string } }>(
    '/api/cadastros/GetPessoa/:idPessoa',
    async (req, reply) => {
      const [p] = await opts.db.buscar<LinhaPessoa>(
        'SELECT idpessoa, nome, cpf, email FROM pessoa WHERE idpessoa = :idPessoa',
        { idPessoa: Number(req.params.idPessoa) },
      );
      if (!p) return reply.code(404).send(NAO_ENCONTRADA);
      return {
        EnderecosPessoa: [],
        EnderecosEmail: p.email ? [{ IdEnderecoEmail: 0, DescricaoObs: '', Email: p.email }] : [],
        ContatosTelefonicos: [],
        CartoesVinculados: [],
        IdPessoa: p.idpessoa,
        DataCadastro: agoraTse(),
        RespCadNome: 'INTEGRACAO TSE',
        DataAlteracao: null,
        RespAltNome: null,
        IdTipoPessoa: 0,
        RazaoSocial: p.nome,
        NomeFantasia: '',
        DataNascimento: null,
        CpfCnpj: p.cpf.replace(/\D/g, ''),
        RgNumero: '',
        RgOrgaoExpedidor: '',
        RgUf: '',
        RgDataEmissao: null,
        PisPasep: '',
        TituloEleitor: '',
        Ctps: '',
        InscricaoEstadual: '',
        InscricaoMunicipal: '',
        IdProfissao: 0,
        IdSexo: 0,
        IdEstadoCivil: 0,
        IdRegimeCasamento: 0,
        IdNacionalidade: 30,
        IdIdioma: 6,
        IdTipoDocumentoPessoa: 0,
      };
    },
  );

  app.get<{ Params: { cpfCnpj: string } }>(
    '/api/cadastros/GetPessoaCpf/:cpfCnpj',
    async (req, reply) => {
      // o TSE aceita o CPF com ou sem máscara; a comparação é por dígito
      const [p] = await opts.db.buscar<LinhaPessoa>(
        `SELECT idpessoa, nome, cpf, email FROM pessoa
          WHERE regexp_replace(cpf, '\\D', '', 'g') = regexp_replace(:cpf, '\\D', '', 'g')`,
        { cpf: req.params.cpfCnpj },
      );
      if (!p) return reply.code(404).send(NAO_ENCONTRADA);
      return { IdPessoa: p.idpessoa, NomePessoa: p.nome, Email: p.email ?? '' };
    },
  );

  done();
}
