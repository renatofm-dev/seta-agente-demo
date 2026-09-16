import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_INADIMPLENTE,
  seedData,
} from '../../../infra/erp-mock/seed.ts';
import type { App } from '../src/app.ts';
import { buildTseSimApp } from '../src/app.ts';
import { type Banco, criarBanco } from '../src/db.ts';
import { loadEnv } from '../src/env.ts';
import { lerFixture, lerIndice } from './fixtures.ts';
import { conferirForma, forma } from './forma.ts';
import { PENDENTES } from './pendentes.ts';

/**
 * O teste que dá sentido à 035: cada rota do simulador é comparada com o
 * exemplo de resposta SALVO DO FORNECEDOR. Sem ambiente do TSE, a coleção É o
 * contrato — e forma (chaves em PascalCase, tipo de cada valor, data com
 * offset) é o que se pode exigir de um dublê. Valor, não: o exemplo é uma
 * amostra de 2021 de outra base.
 *
 * Duas asserções valem o teste inteiro:
 *   1. nenhuma chave do simulador fora do conjunto da fixture — o dublê não
 *      inventa campo que o adapter (036/037) não vai achar no TSE real;
 *   2. `PENDENTES` só encolhe — rota implementada sai da lista.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  TSE_SIM_DATABASE_URL:
    process.env.TSE_SIM_DATABASE_URL ?? 'postgres://tse_sim:tse_sim_dev@localhost:5432/erp_mock',
});

interface Contexto {
  readonly cpfTitular: string;
  readonly idParcelaAberta: number;
}

interface Caso {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: (ctx: Contexto) => string;
  readonly body?: (ctx: Contexto) => unknown;
  /** `/token` é a única rota anônima; as demais exigem bearer. */
  readonly anonima?: true;
  readonly form?: true;
}

const CONTRATO_DEMO = String(CONTRATO_DEMO_INADIMPLENTE);
const painel = (rota: string) => () => `/api/PainelDoCliente/${rota}`;

/** Fixture → como chamar a mesma rota no simulador, com os ids do seed da 012. */
const CASOS: Readonly<Record<string, Caso>> = {
  'authentication__getting-authentication-token': {
    method: 'POST',
    path: () => '/token',
    anonima: true,
    form: true,
    body: () => ({ grant_type: 'password', username: 'integracao', password: 'integracao' }),
  },
  'client-area__my-contracts': { method: 'GET', path: painel('MeusContratos') },
  'client-area__my-cadastral-data': { method: 'GET', path: painel('MeusDadosCadastrais') },
  'client-area__contract-installments': {
    method: 'GET',
    path: () => `/api/PainelDoCliente/FinanceiroContrato?idContrato=${CONTRATO_DEMO}&paginaAtual=1`,
  },
  'client-area__my-tickets': {
    method: 'GET',
    path: () => `/api/PainelDoCliente/MeusBoletos?idContrato=${CONTRATO_DEMO}&paginaAtual=1`,
  },
  'client-area__get-tax-dpnu-contract': {
    method: 'GET',
    path: () => `/api/PainelDoCliente/ObterTaxasDPNU/${CONTRATO_DEMO}`,
  },
  'contract-usase__getting-contracts-by-cpf': {
    method: 'GET',
    path: (ctx) =>
      `/api/utilizacaocontrato/obtercontratos?cpf=${encodeURIComponent(ctx.cpfTitular)}`,
  },
  'general-registers__getting-person-by-id': {
    method: 'GET',
    path: () => '/api/cadastros/GetPessoa/2',
  },
  'general-registers__getting-person-by-cpf': {
    method: 'GET',
    path: (ctx) => `/api/cadastros/GetPessoaCpf/${encodeURIComponent(ctx.cpfTitular)}`,
  },
  // a mesma rota aparece em duas pastas da coleção — as duas fixtures valem
  'system-operator__getting-person-by-cpf': {
    method: 'GET',
    path: (ctx) => `/api/cadastros/GetPessoaCpf/${encodeURIComponent(ctx.cpfTitular)}`,
  },
  'financial__post-eletronic-transaction': {
    method: 'POST',
    path: () => '/api/financeiro/TransacaoEletronica',
    body: (ctx) => ({
      IdContaFinanceira: ctx.idParcelaAberta,
      Valor: 10,
      QuatroPrimeirosDigitosCartao: '4563',
      QuatroUltimosDigitosCartao: '0254',
      CodigoAutorizacao: '254631',
      QuantidadeParcelas: 1,
      NomePessoa: 'INTEGRACAO TSE',
    }),
  },
  'financial__create-installment': {
    method: 'POST',
    path: () => '/api/financeiro/ContaFinanceira',
    body: () => ({
      IdContrato: CONTRATO_DEMO_INADIMPLENTE,
      IdTipoOrigemContaFinanceira: 2,
      IdMeioPagamento: 1,
      DataVencimento: '2026-12-10',
      ValorReceber: 8,
      QuantidadeParcelas: 2,
    }),
  },
  'financial__alter-installment': {
    method: 'PUT',
    path: (ctx) => `/api/financeiro/ContaFinanceira/${ctx.idParcelaAberta}`,
    body: () => ({ ValorReceber: 9, DataVencimento: '2026-12-20' }),
  },
};

// Lookups: 17 tabelas de domínio servidas direto das fixtures — o caso é
// derivado do índice, não escrito à mão, porque a rota É o path da coleção.
for (const entrada of lerIndice()) {
  if (entrada.pasta !== 'Lookups') continue;
  const fixture = lerFixture(entrada.nome);
  const path = entrada.path
    .replace('{{idBandeira}}', '8')
    .replace('{{idPessoa}}', '2')
    .concat(fixture.query.length > 0 ? `?${fixture.query.map((q) => `${q}=1`).join('&')}` : '');
  (CASOS as Record<string, Caso>)[entrada.nome] = { method: 'GET', path: () => path };
}

let admin: pg.Pool;
let db: Banco;
let app: App;
let ctx: Contexto;
let bearer: string;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  await applySchema(admin);
  await seedData(admin);
  const [pessoa] = (
    await admin.query(
      'SELECT cpf FROM pessoa WHERE idpessoa = (SELECT idpessoatitular FROM contrato WHERE idcontrato = $1)',
      [CONTRATO_DEMO_INADIMPLENTE],
    )
  ).rows as { cpf: string }[];
  const [parcela] = (
    await admin.query(
      'SELECT idcontafinanceira FROM contafinanceira WHERE idcontrato = $1 AND datarecebimento IS NULL ORDER BY idcontafinanceira LIMIT 1',
      [CONTRATO_DEMO_INADIMPLENTE],
    )
  ).rows as { idcontafinanceira: number }[];
  ctx = {
    cpfTitular: pessoa?.cpf ?? '',
    idParcelaAberta: parcela?.idcontafinanceira ?? 0,
  };
  db = criarBanco(env.TSE_SIM_DATABASE_URL);
  app = buildTseSimApp({ env, db });
  await app.ready();
  const token = await app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=integracao&password=integracao',
  });
  bearer = `Bearer ${(token.json() as { access_token: string }).access_token}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.fechar();
  // os casos de escrita mexem em contafinanceira: as suítes compartilham o
  // Postgres (fileParallelism: false) e a próxima espera o seed intacto
  if (admin) await seedData(admin);
  await admin?.end();
}, 120_000);

describe('contrato: o simulador responde na forma do TS Explorer', () => {
  for (const [nome, caso] of Object.entries(CASOS)) {
    it(nome, async () => {
      const fixture = lerFixture(nome);
      const resposta = await app.inject({
        method: caso.method,
        url: caso.path(ctx),
        headers: {
          ...(caso.anonima ? {} : { authorization: bearer }),
          ...(caso.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(caso.body
          ? {
              payload: caso.form
                ? new URLSearchParams(caso.body(ctx) as Record<string, string>).toString()
                : (caso.body(ctx) as object),
            }
          : {}),
      });
      expect(resposta.statusCode, `${nome}: ${resposta.body.slice(0, 300)}`).toBe(fixture.status);
      expect(resposta.headers['content-type']).toContain('application/json');
      const erros = conferirForma(forma(fixture.body), forma(resposta.json()));
      expect(erros, `${nome}\n  ${erros.join('\n  ')}`).toEqual([]);
    });
  }
});

describe('contrato: o placar de cobertura', () => {
  it('toda fixture está implementada OU declarada pendente — nenhuma órfã', () => {
    const nomes = lerIndice().map((e) => e.nome);
    const classificadas = new Set([...Object.keys(CASOS), ...PENDENTES]);
    expect(nomes.filter((n) => !classificadas.has(n))).toEqual([]);
    expect(PENDENTES.filter((n) => n in CASOS)).toEqual([]);
    expect(PENDENTES.filter((n) => !nomes.includes(n))).toEqual([]);
  });

  it('PENDENTES só encolhe (035 entregou 30 das 89 rotas da coleção)', () => {
    expect(PENDENTES.length).toBeLessThanOrEqual(59);
  });
});

describe('contrato: procedência e sanitização das fixtures', () => {
  it('nenhum CPF do fornecedor sobrou — todo CPF do contrato/ é fictício (prefixo 000)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '../contrato');
    const arquivos = [
      join(dir, 'tse-api.collection.json'),
      ...readdirSync(join(dir, 'fixtures')).map((f) => join(dir, 'fixtures', f)),
    ];
    const suspeitos: string[] = [];
    for (const arquivo of arquivos) {
      const texto = readFileSync(arquivo, 'utf-8');
      if (/timesharesolucoes/i.test(texto)) suspeitos.push(`${arquivo}: e-mail do fornecedor`);
      for (const m of texto.matchAll(/[^0-9]([0-9]{11})[^0-9]/g)) {
        if (!m[1]?.startsWith('000')) suspeitos.push(`${arquivo}: CPF não fictício ${m[1]}`);
      }
    }
    expect(suspeitos).toEqual([]);
  });

  it('nenhum token do fornecedor sobrou', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const texto = readFileSync(
      join(import.meta.dirname, '../contrato/tse-api.collection.json'),
      'utf-8',
    );
    const tokens = [...texto.matchAll(/"Bearer ([^"]*)"/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    expect([...new Set(tokens)]).toEqual(['SCRUBBED']);
  });
});
