import { join } from 'node:path';
import { createTseErpApi, type ErpWriter } from '@seta/erp-api-tse';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, newTraceId } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminUrl,
  applySchema,
  CONTRATO_DEMO_INADIMPLENTE,
  seedData,
} from '../../../infra/erp-mock/seed.ts';
import { buildTseSimApp } from '../../tse-sim/src/app.ts';
import { criarBanco } from '../../tse-sim/src/db.ts';
import { loadEnv as loadEnvSim } from '../../tse-sim/src/env.ts';
import { FILA_ERP_BAIXA, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  cobranca,
  cobrancaTitulo,
  conversa,
  conversaLeitura,
  erpEscrita,
  eventoTicket,
  pagamento,
  sinalAprendizado,
  ticket,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import {
  chaveBaixa,
  type ErpBaixaDeps,
  enfileirarBaixas,
  processarBaixa,
  registrarBaixasPendentes,
} from '../src/erp/baixa.ts';
import { createExecutorConciliado } from '../src/pagamentos/conciliacao.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { seedApp } from '../src/seed-app.ts';

/**
 * Spec 036 — a baixa deixa de ser ficção.
 *
 * O adapter fala com o simulador da 035 **de verdade**: o `fetchFn` entra no
 * Fastify do `apps/tse-sim` por `inject`, sem porta e sem rede. Ou seja, o
 * caminho exercitado é o mesmo do homelab — HTTP, token, PascalCase, prosa — e
 * o efeito é conferido onde importa: `contafinanceira` e `v_titulo`, lidos pelo
 * papel do PRODUTO (`erp_ro`), que é quem o agente enxerga.
 *
 * Exige o Postgres dev de pé (docker compose -f infra/compose.dev.yml up -d).
 */

const CONTRATO = String(CONTRATO_DEMO_INADIMPLENTE);
const WA_ID = '5511999990036';
const logger = createLogger({ level: 'silent', name: 'teste-036' });

let admin: pg.Pool;
let leitor: pg.Pool;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let env: Env;
let connector: DbConnector;
let executor: Executor;
let simApp: Awaited<ReturnType<typeof buildTseSimApp>>;
let simDb: ReturnType<typeof criarBanco>;
let writer: ErpWriter;
let deps: ErpBaixaDeps;
let conversaId: string;
/** Ligado/desligado pelos testes de falha: simula o TSE fora do ar. */
let quedas = 0;
/** Faz o POST chegar ao TSE mas a RESPOSTA se perder (o caso do read-back). */
let engolirResposta = false;

/** `fetch` que entra direto no Fastify do simulador — o transporte é o inject. */
const fetchNoSimulador: typeof fetch = async (entrada, init) => {
  const url = new URL(String(entrada));
  if (quedas > 0) {
    quedas -= 1;
    throw new TypeError('fetch failed');
  }
  const r = await simApp.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT',
    url: `${url.pathname}${url.search}`,
    headers: init?.headers as Record<string, string>,
    ...(init?.body ? { payload: String(init.body) } : {}),
  });
  if (engolirResposta && url.pathname.includes('TransacaoEletronica')) {
    throw new TypeError('fetch failed'); // a escrita chegou; a resposta não voltou
  }
  return new Response(r.body, {
    status: r.statusCode,
    headers: { 'content-type': r.headers['content-type'] as string },
  });
};

/** Primeira parcela em aberto do contrato inadimplente, direto do erp_mock. */
async function parcelaAberta(): Promise<{ id: string; valorCentavos: number }> {
  const { rows } = await admin.query<{ id: string; valor: string }>(
    `SELECT idcontafinanceira::text AS id, (valorreceber * 100)::bigint::text AS valor
       FROM contafinanceira
      WHERE idcontrato = $1 AND datarecebimento IS NULL AND tipohistorico = 'ATIVO'
      ORDER BY idcontafinanceira LIMIT 1`,
    [CONTRATO_DEMO_INADIMPLENTE],
  );
  return { id: rows[0]?.id as string, valorCentavos: Number(rows[0]?.valor) };
}

/** Cria cobrança paga + `pagamento` + a intenção de baixa, como `marcarPaga` faz. */
async function pagar(tituloId: string, valorCentavos: number, pspCobrancaId: string) {
  const cobrancaId = newTraceId();
  const pagamentoId = newTraceId();
  await db.insert(cobranca).values({
    id: cobrancaId,
    conversaId,
    contratoId: CONTRATO,
    referenciaExterna: `contrato:${CONTRATO}:titulos:${tituloId}`,
    status: 'paga',
    metodo: 'pix',
    valorCentavos,
    vencimentoPsp: '2026-09-18',
    psp: 'asaas',
    pspCobrancaId,
  });
  await db.insert(cobrancaTitulo).values({
    cobrancaId,
    tituloId,
    origem: 'saldo',
    parcela: 1,
    totalParcelas: 100,
    valorCentavos,
    vencimento: '2026-06-27',
  });
  await db.insert(pagamento).values({
    id: pagamentoId,
    contratoId: CONTRATO,
    tituloId,
    cobrancaId,
    valorCentavos,
    metodo: 'pix',
    recebidoEm: new Date(),
    status: 'confirmado',
  });
  const novas = await db.transaction((tx) =>
    registrarBaixasPendentes(tx, [
      {
        pagamentoId,
        contaFinanceiraId: tituloId,
        contratoId: CONTRATO,
        valorCentavos,
        metodo: 'pix',
        referenciaPsp: pspCobrancaId,
      },
    ]),
  );
  return { cobrancaId, pagamentoId, novas };
}

async function jobsNaFila(): Promise<number> {
  const { rows } = await db.execute(
    sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${FILA_ERP_BAIXA}`,
  );
  return (rows[0] as { n: number }).n;
}

async function statusNoProduto(tituloId: string): Promise<string | undefined> {
  const { rows } = await leitor.query<{ status: string }>(
    'SELECT status FROM v_titulo WHERE id = $1',
    [tituloId],
  );
  return rows[0]?.status;
}

async function transacoesNoTse(tituloId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'SELECT count(*) AS n FROM tse_sim.transacaoeletronica WHERE idcontafinanceira = $1',
    [Number(tituloId)],
  );
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'Postgres dev indisponível — suba com: docker compose -f infra/compose.dev.yml up -d --wait',
      { cause: err },
    );
  }
  await applySchema(admin);
  await seedData(admin);
  leitor = new pg.Pool({
    connectionString:
      process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
    max: 2,
  });

  env = loadEnv({
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
    ERP_DATABASE_URL:
      process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
    LOG_LEVEL: 'silent',
    CONTATOS_PATH: join(import.meta.dirname, '../../../configs/demo/contatos.yaml'),
    EMBEDDING_DIM: '8',
  } as NodeJS.ProcessEnv);

  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  // o simulador da 035, de pé em processo
  simDb = criarBanco(
    process.env.TSE_SIM_DATABASE_URL ?? 'postgres://tse_sim:tse_sim_dev@localhost:5432/erp_mock',
  );
  simApp = buildTseSimApp({
    env: loadEnvSim({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    db: simDb,
  });
  await simApp.ready();

  writer = createTseErpApi({
    baseUrl: 'http://tse-sim:3010',
    username: 'integracao',
    password: 'integracao',
    fetchFn: fetchNoSimulador,
    esperar: async () => {},
  });

  boss = await startBoss(env.DATABASE_URL, logger);
  deps = { db, boss, writer, logger };

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  const catalog = await loadCatalog(join(import.meta.dirname, '../../../catalog'));
  executor = createExecutorConciliado(
    createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) }),
    createPagamentosRepo(db, 'auto'),
  );
}, 180_000);

beforeEach(async () => {
  quedas = 0;
  engolirResposta = false;
  await db.delete(erpEscrita);
  await db.delete(pagamento);
  await db.delete(cobrancaTitulo);
  await db.delete(cobranca);
  // a limpeza tem que ser auto-suficiente: quem aponta para ticket sai antes
  await db.delete(eventoTicket);
  await db.delete(sinalAprendizado);
  await db.delete(ticket);
  const [conv] = await db
    .insert(conversa)
    .values({ id: newTraceId(), waId: WA_ID, clienteErpId: CONTRATO })
    .onConflictDoNothing()
    .returning({ id: conversa.id });
  const [existente] = await db.select().from(conversa).where(eq(conversa.waId, WA_ID));
  conversaId = (conv?.id ?? existente?.id) as string;
});

afterAll(async () => {
  // não deixa rastro para a próxima suíte: as outras apagam `conversa` em massa
  await db?.delete(erpEscrita);
  await db?.delete(pagamento);
  await db?.delete(cobrancaTitulo);
  await db?.delete(cobranca);
  await db?.delete(eventoTicket);
  await db?.delete(sinalAprendizado);
  await db?.delete(ticket);
  await db?.delete(conversaLeitura);
  // só a NOSSA conversa: apagar `conversa` em massa aqui derrubaria o que as
  // outras suítes deixaram e estouraria nas FKs delas
  await db?.delete(conversa).where(eq(conversa.waId, WA_ID));
  await boss?.stop({ graceful: false });
  await simApp?.close();
  await simDb?.fechar();
  await connector?.close();
  await closeDb?.();
  await leitor?.end();
  // a suíte baixa parcelas de verdade: devolve o erp_mock intacto
  if (admin) await seedData(admin);
  await admin?.end();
}, 180_000);

describe('a baixa sai da nossa tabela e chega ao ERP', () => {
  it('registra a baixa no TSE e `v_titulo` passa a `pago` na leitura seguinte', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    expect(await statusNoProduto(id)).not.toBe('pago');
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036aaaaaaaaaaaaa');

    expect(await processarBaixa(deps, pagamentoId)).toBe('confirmada');

    const [linha] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveBaixa(pagamentoId)));
    expect(linha?.estado).toBe('confirmada');
    expect(linha?.erpId).toMatch(/^\d+$/);
    // a prova que interessa: o ERP, lido pelo papel do PRODUTO
    expect(await statusNoProduto(id)).toBe('pago');
    const { rows } = await admin.query<{ datarecebimento: string | null }>(
      'SELECT datarecebimento FROM contafinanceira WHERE idcontafinanceira = $1',
      [Number(id)],
    );
    expect(rows[0]?.datarecebimento).not.toBeNull();
  });

  it('o id da cobrança no PSP viaja no CodigoAutorizacao — o link com o extrato', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036bbbbbbbbbbbbb');

    await processarBaixa(deps, pagamentoId);

    const { rows } = await admin.query<{ codigoautorizacao: string }>(
      'SELECT codigoautorizacao FROM tse_sim.transacaoeletronica WHERE idcontafinanceira = $1',
      [Number(id)],
    );
    expect(rows[0]?.codigoautorizacao).toBe('pay_036bbbbbbbbbbbbb');
  });

  it('confirmada no ERP, a conciliação PARA de compensar — sem contagem dupla', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036ccccccccccccc');
    const repo = createPagamentosRepo(db, 'auto');

    // em voo: a compensação segura a conversa
    expect(await repo.pagosDoContrato(CONTRATO)).toHaveLength(1);

    await processarBaixa(deps, pagamentoId);

    // confirmada: a verdade passa a ser do ERP
    expect(await repo.pagosDoContrato(CONTRATO)).toHaveLength(0);
    // e com `on` o comportamento antigo continua disponível
    expect(await createPagamentosRepo(db, 'on').pagosDoContrato(CONTRATO)).toHaveLength(1);
  });

  /**
   * O alvo sai de `v_titulo`, e NÃO de uma consulta que rededuz a regra na mão.
   * A view descarta datas fora da janela de sanidade (o seed da 012 planta
   * `datavencimentorecorrencia = 1900-01-01` de propósito, porque o espelho real
   * tem isso), então "vencida" só quer dizer o que a view diz que quer dizer —
   * que é o que o agente enxerga.
   */
  it('o agente deixa de ver a parcela em `titulos_atraso`, lendo o ERP e não a compensação', async () => {
    const { rows: vencidas } = await leitor.query<{ id: string; valor: string }>(
      `SELECT id, valor_centavos::text AS valor FROM v_titulo
        WHERE contrato_id = $1 AND status = 'vencido' ORDER BY vencimento LIMIT 1`,
      [CONTRATO],
    );
    const alvo = vencidas[0]?.id as string;
    const sessao = { traceId: newTraceId(), clienteId: CONTRATO };
    const antes = await executor.run('financeiro.titulos_atraso', {}, sessao);
    expect(antes.rows.map((r) => String(r.id))).toContain(alvo);

    const { pagamentoId } = await pagar(alvo, Number(vencidas[0]?.valor), 'pay_036ddddddddddddd');
    await processarBaixa(deps, pagamentoId);

    const depois = await executor.run('financeiro.titulos_atraso', {}, sessao);
    expect(depois.rows.map((r) => String(r.id))).not.toContain(alvo);
  });
});

describe('idempotência: o webhook reentrega e o pg-boss re-tenta', () => {
  it('processar a mesma baixa duas vezes NÃO gera segunda transação no TSE', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036eeeeeeeeeeeee');

    expect(await processarBaixa(deps, pagamentoId)).toBe('confirmada');
    expect(await processarBaixa(deps, pagamentoId)).toBe('ja-resolvida');

    expect(await transacoesNoTse(id)).toBe(1);
  });

  it('a intenção de baixa é PK: a reentrega do webhook não cria job novo', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId, novas } = await pagar(id, valorCentavos, 'pay_036fffffffffffff');
    expect(novas).toEqual([pagamentoId]);

    const repetidas = await db.transaction((tx) =>
      registrarBaixasPendentes(tx, [
        {
          pagamentoId,
          contaFinanceiraId: id,
          contratoId: CONTRATO,
          valorCentavos,
          metodo: 'pix',
          referenciaPsp: 'pay_036fffffffffffff',
        },
      ]),
    );
    expect(repetidas).toEqual([]);
  });

  /**
   * O caso que justifica o read-back existir: o POST CHEGA ao TSE, a parcela é
   * baixada, e a resposta se perde. Repetir o POST cegamente registraria a
   * baixa duas vezes — o TSE não é idempotente.
   */
  it('resposta perdida: o read-back vê a parcela paga e NÃO repete a baixa', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036ggggggggggggg');

    engolirResposta = true;
    // o POST chegou e baixou a parcela; só a resposta se perdeu. O worker NÃO
    // repete o POST: pergunta ao ERP e fecha na mesma tentativa.
    expect(await processarBaixa(deps, pagamentoId)).toBe('read-back');
    engolirResposta = false;

    expect(await transacoesNoTse(id)).toBe(1);
    const [linha] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveBaixa(pagamentoId)));
    expect(linha?.estado).toBe('confirmada');
    // e o erp_id fica nulo: a baixa existe, o id da transação foi embora com a
    // resposta perdida — o rastro no TSE é o CodigoAutorizacao
    expect(linha?.erpId).toBeNull();
  });

  it('read-back que NÃO acha a parcela paga deixa o erro subir para o pg-boss', async () => {
    const { pagamentoId } = await pagar('99999998', 5_000, 'pay_036kkkkkkkkkkkkk');

    quedas = 1; // cai antes de chegar ao TSE: nada foi gravado lá
    await expect(processarBaixa(deps, pagamentoId)).rejects.toThrow(/sem resposta/);

    const [linha] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveBaixa(pagamentoId)));
    expect(linha?.estado).toBe('pendente');
  });
});

describe('quando o ERP não colabora', () => {
  it('TSE fora do ar: fica `pendente` com o erro registrado, e o erro sobe para o pg-boss', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036hhhhhhhhhhhhh');

    quedas = 99;
    await expect(processarBaixa(deps, pagamentoId)).rejects.toThrow();
    quedas = 0;

    const [linha] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveBaixa(pagamentoId)));
    expect(linha?.estado).toBe('pendente');
    expect(linha?.erro).toMatch(/sem resposta/);
    expect(await transacoesNoTse(id)).toBe(0);
    // e a conversa continua correta enquanto isso: a compensação ainda vale
    expect(await createPagamentosRepo(db, 'auto').pagosDoContrato(CONTRATO)).toHaveLength(1);
  });

  it('parcela inexistente: `falha` definitiva, sem retry, e um humano assume', async () => {
    const { pagamentoId } = await pagar('99999999', 12_345, 'pay_036iiiiiiiiiiiii');

    expect(await processarBaixa(deps, pagamentoId)).toBe('falha');

    const [linha] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveBaixa(pagamentoId)));
    expect(linha?.estado).toBe('falha');
    const [t] = await db.select().from(ticket).where(eq(ticket.conversaId, conversaId));
    expect(t?.status).toBe('aguardando_humano');
  });
});

describe('a fila', () => {
  /**
   * Aqui o teste para no limite do que é NOSSO: a intenção vira job na fila
   * certa, e o job é criado uma vez só. Consumir é garantia do pg-boss, e um
   * caso que dependia do polling passava sozinho e falhava na suíte completa
   * (dezenas de instâncias sobem e param sobre o mesmo schema `pgboss`) — o
   * handler em si está coberto pelos casos acima, que o chamam direto.
   */
  it('enfileira UM job em FILA_ERP_BAIXA e nada além disso', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId, novas } = await pagar(id, valorCentavos, 'pay_036jjjjjjjjjjjjj');
    expect(novas).toEqual([pagamentoId]);
    const antes = await jobsNaFila();

    await enfileirarBaixas(boss, novas);

    const depois = await jobsNaFila();
    expect(depois - antes).toBe(1);
    const [job] = (
      await db.execute(
        sql`SELECT data FROM pgboss.job WHERE name = ${FILA_ERP_BAIXA}
             ORDER BY created_on DESC LIMIT 1`,
      )
    ).rows as { data: { pagamentoId: string } }[];
    expect(job?.data.pagamentoId).toBe(pagamentoId);
  });

  it('reentrega do webhook não vira job novo: sem linha nova, nada a enfileirar', async () => {
    const { id, valorCentavos } = await parcelaAberta();
    const { pagamentoId } = await pagar(id, valorCentavos, 'pay_036lllllllllllll');
    const antes = await jobsNaFila();

    const repetidas = await db.transaction((tx) =>
      registrarBaixasPendentes(tx, [
        {
          pagamentoId,
          contaFinanceiraId: id,
          contratoId: CONTRATO,
          valorCentavos,
          metodo: 'pix',
          referenciaPsp: 'pay_036lllllllllllll',
        },
      ]),
    );
    await enfileirarBaixas(boss, repetidas);

    expect(await jobsNaFila()).toBe(antes);
  });
});

describe('a fila existe no boot', () => {
  it('FILA_ERP_BAIXA é separada da fila de eventos do PSP', () => {
    expect(FILA_ERP_BAIXA).toBe('erp-baixa');
  });
});
