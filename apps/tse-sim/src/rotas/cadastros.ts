import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
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

export function cadastrosRoutes(app: FastifyInstance, opts: CadastrosDeps, done: () => void): void {
  exigirBearer(app, opts.auth);

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
