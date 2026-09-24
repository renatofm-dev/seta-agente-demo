import { join } from 'node:path';
import { createAssinaturaSimulada } from '@seta/assinatura';
import { loadClientConfig } from '@seta/client-config';
import { createErpSimulado, type ErpSimulado } from '@seta/erp-api-tse';
import { createLogger } from '@seta/observability';
import { asc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type App, buildApp } from '../src/app.ts';
import type { AssinaturaDeps } from '../src/assinatura/fluxo.ts';
import {
  enviarParaAssinatura,
  TEXTO_ASSINADO,
  TEXTO_CONTRATO_NAO_SAIU,
} from '../src/assinatura/fluxo.ts';
import { startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { assinatura, conversa, outbox, venda } from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';

/**
 * 046 — o contrato vai para assinatura e volta assinado.
 *
 * O que este teste guarda é a REGRA DA ORDEM: o documento só nasce depois que
 * o contrato existe no ERP, e o que chega ao comprador é o link — nunca o PDF
 * cru, nunca um atalho que pule o `lerEvento` do provider. O aceite entra pelo
 * mesmo caminho que o Autentique usaria.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const CONTRATO_ERP = '10123';
const DOC_ID = 'doc-de-teste-046';
const WA_ID = '5511999990046';
/** Ids FIXOS: a limpeza precisa alcançar a sobra de uma execução anterior, e
 *  variável só existe depois do primeiro `beforeEach` deste processo. */
const CONVERSA_ID = '01a0d500-0000-7000-8000-000000000046';
const VENDA_ID = '01a0d500-0000-7000-8000-000000000146';

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let erp: ErpSimulado;
let deps: AssinaturaDeps;
let app: App;
let conversaId = '';
let vendaId = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);

beforeAll(async () => {
  env = loadEnv({
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
    ERP_DATABASE_URL:
      process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
    LOG_LEVEL: 'silent',
    EMBEDDING_DIM: '8',
  } as NodeJS.ProcessEnv);
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  boss = await startBoss(env.DATABASE_URL);

  erp = createErpSimulado();
  erp.semearContrato(CONTRATO_ERP, PDF);

  deps = {
    db,
    boss,
    logger: createLogger({ name: 'teste', level: 'silent' }),
    provider: createAssinaturaSimulada({ baseUrl: 'https://tunel.test', novoId: () => DOC_ID }),
    erp,
  };
  app = buildApp({ env, clientConfig, wa: { db, boss }, assinatura: deps });
  await app.ready();
}, 120_000);

afterAll(async () => {
  /**
   * Limpar o que este arquivo criou é obrigação, não boa vontade: o `app_test`
   * é compartilhado e outros arquivos limpam a `conversa` INTEIRA no setup
   * deles. Uma `venda` órfã apontando para a conversa daqui faz o `delete` do
   * vizinho bater em violação de chave estrangeira — e o arquivo dele falha
   * inteiro, no setup, longe da causa.
   */
  await limpar();
  await app?.close();
  await boss?.stop({ graceful: false });
  await closeDb?.();
});

beforeEach(async () => {
  /**
   * Limpeza ESCOPADA. Os arquivos rodam em série (`fileParallelism: false`),
   * mas dividem o mesmo banco: um `delete(outbox)` sem `where` apaga a fila
   * que outro arquivo deixou para trás, e some com a evidência de quem for
   * investigar. Escopar é o que mantém cada arquivo dono do que ele criou.
   */
  await limpar();

  const [c] = await db
    .insert(conversa)
    .values({
      id: CONVERSA_ID,
      waId: WA_ID,
      janelaExpiraEm: new Date(Date.now() + 3_600_000),
    })
    .returning();
  conversaId = c?.id ?? '';
  const [v] = await db
    .insert(venda)
    .values({
      id: VENDA_ID,
      conversaId,
      status: 'registrada',
      comprador: { nome: 'Joana Pereira Lima', cpf: '00035417544' },
      /**
       * Cota que NÃO existe no estoque do seed. `venda_cota_uq` é um índice
       * único parcial por cota entre as vendas vivas: fixar aqui uma cota real
       * bloqueia o fluxo de venda dos outros arquivos, que escolhem a cota a
       * partir do estoque disponível — e eles quebram sem ter defeito nenhum.
       */
      cotaId: '999999',
      cotaCodigo: 'C999-999',
      idProduto: 111,
      valorCentavos: 14_433_600,
      sinalCentavos: 200_000,
      erpContratoId: CONTRATO_ERP,
    })
    .returning();
  vendaId = v?.id ?? '';
  erp.semearContrato(CONTRATO_ERP, PDF);
});

/** Na ordem das chaves estrangeiras: o que aponta some antes do que é apontado. */
async function limpar(): Promise<void> {
  await db.delete(assinatura).where(eq(assinatura.vendaId, VENDA_ID));
  await db.delete(outbox).where(eq(outbox.conversaId, CONVERSA_ID));
  await db.delete(venda).where(eq(venda.id, VENDA_ID));
  await db.delete(conversa).where(eq(conversa.waId, WA_ID));
}

const linhas = () =>
  db.select().from(outbox).where(eq(outbox.conversaId, conversaId)).orderBy(asc(outbox.criadoEm));
const venderParaAssinar = () =>
  enviarParaAssinatura(deps, {
    id: vendaId,
    conversaId,
    contratoErpId: CONTRATO_ERP,
    compradorNome: 'Joana Pereira Lima',
    compradorCpf: '00035417544',
  });

describe('046: o contrato vai para assinatura', () => {
  it('cria o documento e manda o LINK — nunca o PDF', async () => {
    const r = await venderParaAssinar();
    expect(r.estado).toBe('enviada');

    const [linha] = await db.select().from(assinatura).where(eq(assinatura.vendaId, vendaId));
    expect(linha).toMatchObject({
      vendaId,
      provedor: 'simulado',
      documentoId: DOC_ID,
      contratoErpId: CONTRATO_ERP,
      estado: 'pendente',
      link: `https://tunel.test/assinar/${DOC_ID}`,
    });

    const saidas = await linhas();
    expect(saidas).toHaveLength(1);
    expect(saidas[0]?.texto).toContain(`https://tunel.test/assinar/${DOC_ID}`);
    // o arquivo NÃO vai agora: quem assina abre o link e lê antes
    expect(saidas[0]?.anexo).toBeNull();
    expect(JSON.stringify(saidas)).not.toContain('%PDF');
  });

  it('chamar de novo reenvia o mesmo link, sem criar um segundo documento', async () => {
    await venderParaAssinar();
    const r = await venderParaAssinar();

    expect(r.estado).toBe('reenviada');
    expect(await db.select().from(assinatura).where(eq(assinatura.vendaId, vendaId))).toHaveLength(
      1,
    );
  });

  it('ERP sem o documento: o comprador ouve isso, e nada é criado', async () => {
    const semContrato = createErpSimulado();
    const r = await enviarParaAssinatura(
      { ...deps, erp: semContrato },
      {
        id: vendaId,
        conversaId,
        contratoErpId: CONTRATO_ERP,
        compradorNome: 'Joana Pereira Lima',
      },
    );

    expect(r.estado).toBe('sem_documento');
    expect(await db.select().from(assinatura).where(eq(assinatura.vendaId, vendaId))).toHaveLength(
      0,
    );
    const saidas = await linhas();
    expect(saidas[0]?.texto).toBe(TEXTO_CONTRATO_NAO_SAIU);
  });
});

describe('046: a página de assinatura e a volta do aceite', () => {
  it('a página mostra o contrato e oferece o PDF para ler antes', async () => {
    await venderParaAssinar();

    const r = await app.inject({ method: 'GET', url: `/assinar/${DOC_ID}` });

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain(`nº ${CONTRATO_ERP}`);
    expect(r.body).toContain(`/assinar/${DOC_ID}/contrato.pdf`);
    // a tarja não é opcional: assinatura simulada não pode parecer jurídica
    expect(r.body).toContain('não tem validade jurídica');
  });

  it('o PDF do contrato é servido pelo mesmo segredo do link', async () => {
    await venderParaAssinar();

    const r = await app.inject({ method: 'GET', url: `/assinar/${DOC_ID}/contrato.pdf` });

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('assinar marca a linha e manda a via pelo WhatsApp', async () => {
    await venderParaAssinar();

    const r = await app.inject({ method: 'POST', url: `/assinar/${DOC_ID}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Contrato assinado');

    const [linha] = await db.select().from(assinatura).where(eq(assinatura.vendaId, vendaId));
    expect(linha?.estado).toBe('assinada');
    expect(linha?.assinadoEm).toBeInstanceOf(Date);

    const saidas = await linhas();
    expect(saidas.map((l) => l.texto)).toContain(TEXTO_ASSINADO);
    const via = saidas.find((l) => l.anexo !== null);
    expect(via?.anexo).toMatchObject({
      tipo: 'contrato',
      contratoErpId: CONTRATO_ERP,
      filename: `contrato-${CONTRATO_ERP}.pdf`,
    });
  });

  it('assinar duas vezes não manda a via duas vezes', async () => {
    await venderParaAssinar();
    await app.inject({ method: 'POST', url: `/assinar/${DOC_ID}` });
    await app.inject({ method: 'POST', url: `/assinar/${DOC_ID}` });

    const comAnexo = (await linhas()).filter((l) => l.anexo !== null);
    expect(comAnexo).toHaveLength(1);
  });

  it('webhook de documento desconhecido responde 200 e não faz nada', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/assinatura',
      payload: { documento: 'documento-que-nao-existe', estado: 'assinada' },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ recebido: true, aplicado: false });
    expect(await linhas()).toHaveLength(0);
  });

  it('link inexistente é 404 com página, não erro cru', async () => {
    const r = await app.inject({ method: 'GET', url: '/assinar/nao-existe-mesmo' });

    expect(r.statusCode).toBe(404);
    expect(r.body).toContain('Link não encontrado');
  });
});
