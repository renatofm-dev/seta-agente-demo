import { join } from 'node:path';
import { TEXTO_TRANSICAO } from '@seta/agent';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { TEXTO_INTERESSE_COMPRA } from '@seta/cobranca';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter, newTraceId } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import {
  type CotaDisponivel,
  formatarReais,
  pisoCentavos,
  TEXTO_AGENDAMENTO,
  TEXTO_QUALIFICACAO_PERIODOS,
  TEXTO_QUALIFICACAO_PESSOAS,
} from '@seta/sdr';
import { asc, count, desc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  chunk,
  conversa,
  documento,
  eventoQuery,
  eventoTicket,
  fluxoSdr,
  lead,
  mensagem,
  outbox,
  propostaSdr,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { createSdrRepo } from '../src/sdr/repo.ts';
import { seedApp } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Spec 015a — agente SDR para lead frio, ponta a ponta VIA SIMULADOR: LLM fake
 * (só o classificador e o agente geral), estoque REAL do ERP mock (spec 012 +
 * 015) pelo catálogo, alçada de 3%. Exige Postgres dev.
 */

const DEBOUNCE_MS = 300;
const LEAD_A = '5511987650001'; // sem vínculo
const LEAD_B = '5511987650002';
const LEAD_C = '5511987650003';
const WA_VINCULADO = '5511999990001'; // contrato 10001
const BPS = 300;
const logger = createLogger({ name: 'teste-sdr', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function traces(): Promise<number> {
  return (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
}

/** Manda uma mensagem e espera o turno fechar (trace é gravado por último). */
async function turnoDe(waId: string, text: string): Promise<string> {
  const antes = await traces();
  const res = await app.inject({ method: 'POST', url: '/dev/inbound', payload: { waId, text } });
  expect(res.statusCode).toBe(202);
  await aguardar(async () => (await traces()) === antes + 1);
  const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
  return linhas[linhas.length - 1]?.texto ?? '';
}

/** Sempre por criado_em: sem ORDER BY, o heap reusa espaço liberado pelos DELETE e a ordem mente. */
async function ultimoTrace() {
  const [ultimo] = await db.select().from(traceTurno).orderBy(desc(traceTurno.criadoEm)).limit(1);
  if (!ultimo) throw new Error('sem trace');
  return ultimo;
}

/** Triggers de escalada registrados nos eventos `verdict` do trace. */
function triggersDe(trace: { eventos: unknown }): string[] {
  return (trace.eventos as { tipo: string; verdict?: { trigger?: string } }[])
    .filter((e) => e.tipo === 'verdict')
    .map((e) => e.verdict?.trigger)
    .filter((t): t is string => typeof t === 'string');
}

async function propostaUnica() {
  const linhas = await db.select().from(propostaSdr);
  expect(linhas).toHaveLength(1);
  const p = linhas[0];
  if (!p) throw new Error('sem proposta');
  return p;
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: adminUrl(), max: 2 });
  await admin.query('SELECT 1');
  await applySchema(admin);
  await seedData(admin);

  env = {
    ...loadEnv({
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
      ERP_DATABASE_URL:
        process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
      LOG_LEVEL: 'silent',
      DEV_SIMULATOR: 'true',
      CONTATOS_PATH: join(import.meta.dirname, '../../../configs/demo/contatos.yaml'),
      EMBEDDING_DIM: '8',
      SDR_DESCONTO_MAX_BPS: String(BPS),
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  executor = createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) });

  boss = await startBoss(env.DATABASE_URL, logger);
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    handler: createAgentTurnoHandler({
      db,
      boss,
      get provider() {
        return fake;
      },
      catalog,
      executor,
      clientConfig,
      registry: null,
      store: createPgVectorStore({ db, dim: env.EMBEDDING_DIM }),
      obs: createNoopObsEmitter(),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
      sdr: { repo: createSdrRepo(db), env },
    }),
    logger,
  });
  app = buildApp({ env, clientConfig, wa: { db, boss } });
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(propostaSdr);
      await db.delete(fluxoSdr);
      await db.delete(lead);
      await db.delete(chunk);
      await db.delete(documento);
      await db.delete(sinalAprendizado);
      await db.delete(eventoTicket);
      await db.delete(ticket);
      await db.delete(traceTurno);
      await db.delete(eventoQuery);
      await db.delete(outbox);
      await db.delete(mensagem);
      await db.delete(turno);
      await db.delete(conversa);
      break;
    } catch (err) {
      if (tentativa >= 4) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('critérios spec 015a (via simulador)', { timeout: 90_000 }, () => {
  it('lead frio: qualifica → lista o estoque real → oferta na tabela → piso → pedido abaixo do piso escala', async () => {
    fake.respondeTexto('comprar_cota'); // classificador — o resto é parser determinístico
    expect(await turnoDe(LEAD_A, 'quero comprar uma cota, quanto custa?')).toBe(
      TEXTO_QUALIFICACAO_PESSOAS,
    );
    const [l] = await db.select().from(lead).where(eq(lead.waId, LEAD_A));
    expect(l?.status).toBe('qualificando');

    expect(await turnoDe(LEAD_A, '4')).toBe(TEXTO_QUALIFICACAO_PERIODOS);

    const lista = await turnoDe(LEAD_A, '2');
    expect(lista).toContain('Encontrei estas opções para 4 pessoa(s), 2 vezes por ano');
    expect(lista).toMatch(/1\) .* — R\$ [\d.]+,\d{2}/);
    const [fluxo] = await db.select().from(fluxoSdr);
    const opcoes = fluxo?.opcoes as CotaDisponivel[];
    expect(opcoes.length).toBeGreaterThan(0);
    expect(opcoes.length).toBeLessThanOrEqual(3);
    for (const c of opcoes) {
      expect(c.capacidade).toBeGreaterThanOrEqual(4);
      expect(c.periodos).toBe(2);
    }
    // mais baratas primeiro, tier×modelo distintos
    const valores = opcoes.map((c) => c.valorTabelaCentavos);
    expect([...valores].sort((a, b) => a - b)).toEqual(valores);
    expect(new Set(opcoes.map((c) => `${c.tier}|${c.modelo}`)).size).toBe(opcoes.length);

    const escolhida = opcoes[0] as CotaDisponivel;
    const tabela = escolhida.valorTabelaCentavos;
    const piso = pisoCentavos(tabela, BPS);

    // oferta na TABELA — a proposta já está gravada quando a mensagem sai
    expect(await turnoDe(LEAD_A, '1')).toContain(`está ${formatarReais(tabela)} à vista`);
    let p = await propostaUnica();
    expect(p).toMatchObject({
      status: 'ofertada',
      cotaId: escolhida.cotaId,
      valorTabelaCentavos: tabela,
      valorMinimoCentavos: piso,
      valorOfertadoCentavos: tabela,
      descontoBps: 0,
    });
    expect((await db.select().from(lead))[0]?.status).toBe('proposta');

    // pede melhor: PISO, mesma proposta atualizada (não cria outra)
    expect(await turnoDe(LEAD_A, 'consegue melhorar?')).toContain(
      `em ${formatarReais(piso)} à vista`,
    );
    p = await propostaUnica();
    expect(p).toMatchObject({ valorOfertadoCentavos: piso, descontoBps: BPS, status: 'ofertada' });

    // abaixo do piso: escala com a proposta aguardando aprovação
    // (a mais barata do estoque real é a Ouro Special 2p, R$ 68.250 — 50 mil fica abaixo do piso)
    expect(5_000_000).toBeLessThan(piso);
    const resposta = await turnoDe(LEAD_A, 'fecho por 50 mil');
    expect(resposta).toContain('R$ 50.000,00 passa da minha alçada');
    p = await propostaUnica();
    expect(p).toMatchObject({ status: 'aguardando_aprovacao', valorPedidoCentavos: 5_000_000 });
    const [tk] = await db.select().from(ticket);
    expect(tk?.status).toBe('aguardando_humano');
    expect(tk?.motivoEscalonamento).toContain('validar proposta');
    const trace = await ultimoTrace();
    expect(trace.escalado).toBe(true);
    const eventos = trace.eventos as { tipo: string; acao?: string }[];
    expect(eventos.some((e) => e.tipo === 'sdr' && e.acao === 'pedir_valor')).toBe(true);
    expect(eventos.some((e) => e.tipo === 'escalado')).toBe(true);
    // o trigger da escalada fica no sinal de aprendizado (mesma mecânica da 014)
    const [sinal] = await db.select().from(sinalAprendizado);
    expect((sinal?.payload as { trigger?: string } | undefined)?.trigger).toBe(
      'desconto_acima_alcada',
    );

    // só o classificador do 1º turno gastou LLM: todo o resto foi parser
    expect(fake.requests).toHaveLength(1);
  });

  it('caminho feliz até o agendamento; depois o agente geral atende o lead com as tools comerciais', async () => {
    fake.respondeTexto('comprar_cota');
    await turnoDe(LEAD_B, 'quero comprar uma cota');
    await turnoDe(LEAD_B, '2');
    await turnoDe(LEAD_B, '1');
    await turnoDe(LEAD_B, '1');
    expect(await turnoDe(LEAD_B, 'sim')).toBe(TEXTO_AGENDAMENTO);
    const fim = await turnoDe(LEAD_B, 'Renato, amanhã às 10h');
    expect(fim).toContain('Renato, amanhã às 10h');
    const [l] = await db.select().from(lead).where(eq(lead.waId, LEAD_B));
    expect(l?.status).toBe('agendado');
    expect((l?.perfil as { contato?: string } | undefined)?.contato).toBe('Renato, amanhã às 10h');
    expect((await propostaUnica()).status).toBe('aceita');
    expect((await db.select().from(fluxoSdr))[0]).toMatchObject({
      etapa: 'encerrado',
      encerramento: 'agendado',
    });

    // fluxo encerrado: a próxima mensagem cai no agente geral, na raia do lead
    fake.respondeTexto('outro').respondeTexto('Combinado! Qualquer dúvida é só chamar.');
    await turnoDe(LEAD_B, 'obrigado!');
    const trace = await ultimoTrace();
    const contexto = (trace.eventos as { tipo: string; tools?: string[] }[]).find(
      (e) => e.tipo === 'contexto',
    );
    expect(contexto?.tools).toEqual(
      expect.arrayContaining(['estoque_disponivel', 'condicoes_cota', 'buscar_conhecimento']),
    );
    expect(contexto?.tools).not.toContain('minha_cota');
    expect(contexto?.tools).not.toContain('saldo_contrato');
    // persona comercial na raia do lead ([1] é o classificador deste turno, [2] o agente)
    expect(fake.requests[2]?.messages[0]?.content).toContain('assistente comercial');
  });

  it('agente da raia do lead: o piso do SQL é o da fórmula, o guardrail aceita o piso e barra 1 centavo abaixo', async () => {
    // a cota mais barata do estoque real, lida pelo catálogo como o agente faria
    const session = { traceId: newTraceId(), clienteId: '', descontoMaxBps: BPS };
    const estoque = await executor.run('comercial.estoque_disponivel', {}, session);
    const barata = estoque.rows[0] as { cota_id: string; valor_tabela_centavos: string | number };
    const tabela = Number(barata.valor_tabela_centavos);
    const piso = pisoCentavos(tabela, BPS);

    // turno 1: oferta no piso — passa
    fake
      .respondeTexto('outro')
      .chamaTool('condicoes_cota', { cota_id: barata.cota_id })
      .respondeTexto(`Consigo fechar em ${formatarReais(piso)} à vista.`);
    const ok = await turnoDe(LEAD_C, 'quanto custa a cota mais barata?');
    expect(ok).toBe(`Consigo fechar em ${formatarReais(piso)} à vista.`);
    const toolResult = fake.requests[2]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toContain(`"valor_minimo_centavos":"${piso}"`); // SQL == fórmula
    expect((await ultimoTrace()).escalado).toBe(false);

    // turno 2: 1 centavo abaixo do piso — o guardrail de preço escala sozinho
    fake
      .respondeTexto('outro')
      .chamaTool('condicoes_cota', { cota_id: barata.cota_id })
      .respondeTexto(`Consigo fechar em ${formatarReais(piso - 1)} à vista.`);
    expect(await turnoDe(LEAD_C, 'e se eu pagar um pouco menos?')).toBe(TEXTO_TRANSICAO);
    const trace = await ultimoTrace();
    expect(trace.escalado).toBe(true);
    expect(triggersDe(trace)).toContain('negociacao_preco');
  });

  it('cotista COM vínculo pedindo outra cota continua escalando interesse_compra (sem regressão)', async () => {
    fake.respondeTexto('comprar_cota');
    expect(await turnoDe(WA_VINCULADO, 'quero comprar mais uma cota')).toBe(TEXTO_INTERESSE_COMPRA);
    expect(await db.select().from(fluxoSdr)).toHaveLength(0);
    expect(await db.select().from(lead)).toHaveLength(0);
    expect(triggersDe(await ultimoTrace())).toContain('interesse_compra');
  });
});
