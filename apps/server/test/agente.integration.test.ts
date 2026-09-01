import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter, newTraceId } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { count } from 'drizzle-orm';
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
  mensagem,
  outbox,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios das specs 005/012, ponta a ponta VIA SIMULADOR (provider fake
 * determinístico, dados reais do seed da 012 através do catálogo). Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
// wa_id vinculado ao contrato 10001 (ativo, em dia) no configs/demo/contatos.yaml
const WA_ID_VINCULADO = '5511999990001';
const logger = createLogger({ name: 'teste-agente', level: 'silent' });

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

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function enviarPeloSimulador(waId: string, text: string) {
  const res = await app.inject({ method: 'POST', url: '/dev/inbound', payload: { waId, text } });
  expect(res.statusCode).toBe(202);
}

async function aguardarResposta(): Promise<{
  resposta: string;
  trace: typeof traceTurno.$inferSelect;
}> {
  await aguardar(async () => (await db.select({ n: count() }).from(traceTurno))[0]?.n === 1);
  const [trace] = await db.select().from(traceTurno);
  if (!trace) throw new Error('sem trace');
  const [linhaOutbox] = await db.select().from(outbox);
  return { resposta: linhaOutbox?.texto ?? '', trace };
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

  env = {
    ...loadEnv({
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
      ERP_DATABASE_URL:
        process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
      LOG_LEVEL: 'silent',
      DEV_SIMULATOR: 'true',
      CONTATOS_PATH: join(import.meta.dirname, '../../../configs/demo/contatos.yaml'),
      EMBEDDING_DIM: '8', // fake provider embeda em 8 dims
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env); // vínculo contato↔cliente agora vem da tabela (007)

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  executor = createExecutor({
    catalog,
    connector,
    sink: createDrizzleQueryEventSink(db),
  });

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
      registry: null, // skills fora destes cenários (009 tem suíte própria)
      store: createPgVectorStore({ db, dim: env.EMBEDDING_DIM }),
      obs: createNoopObsEmitter(),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99, // sem sumarização nestes testes
    }),
    logger,
  });
  app = buildApp({ env, clientConfig, wa: { db, boss } });
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  // turno em voo do teste anterior pode gravar trace no meio da limpeza (FK);
  // com as filas já limpas, repetir a limpeza resolve na 2ª tentativa
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(chunk); // KB vazia: buscar_conhecimento devolve [] nestes cenários
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

describe('critérios spec 005 (via simulador)', () => {
  it('critério 012: pergunta de saldo → tool certa → resposta com valor do seed', async () => {
    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .chamaTool('saldo_contrato', {})
      .respondeTexto('Seu contrato tem parcelas em aberto! Te passo o resumo do saldo.');

    await enviarPeloSimulador(WA_ID_VINCULADO, 'quanto ainda falta pagar do meu contrato?');
    const { resposta, trace } = await aguardarResposta();

    // a tool certa rodou e o RESULTADO REAL DO SEED voltou ao modelo
    const toolResult = fake.requests[2]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toContain('saldo_devedor_centavos');
    expect(toolResult?.content).toContain('parcelas_em_aberto');

    expect(resposta).toContain('saldo');
    expect(trace.fallback).toBe(false);
    const eventos = trace.eventos as { tipo: string; nome?: string }[];
    expect(eventos.map((e) => e.tipo)).toEqual(['contexto', 'llm', 'tool', 'llm']);
    expect(eventos.find((e) => e.tipo === 'tool')?.nome).toBe('saldo_contrato');

    // auditoria do catálogo também registrou a execução
    const [ev] = await db.select().from(eventoQuery);
    expect(ev?.entryId).toBe('financeiro.saldo_contrato');
    expect(ev?.ok).toBe(true);
  }, 20_000);

  it('critério 012: pergunta de reserva → agente admite não saber e escala', async () => {
    // reserva/calendário NÃO tem caminho de dado neste domínio (fora do espelho)
    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .chamaTool('escalar_para_humano', { motivo: 'reserva de período — sem caminho de dado' })
      .respondeTexto(
        'A marcação de períodos eu não consigo fazer por aqui — já acionei um atendente da central para te ajudar!',
      );

    await enviarPeloSimulador(WA_ID_VINCULADO, 'quero reservar minha semana de janeiro');
    const { resposta, trace } = await aguardarResposta();

    expect(resposta).toMatch(/atendente/);
    expect(trace.escalado).toBe(true);
    const [tk] = await db.select().from(ticket);
    expect(tk?.status).toBe('aguardando_humano');
    // nenhuma tool de dado cobre reserva — só a escalada rodou
    const eventos = trace.eventos as { tipo: string; nome?: string }[];
    expect(eventos.filter((e) => e.tipo === 'tool').map((e) => e.nome)).toEqual([
      'escalar_para_humano',
    ]);
  }, 20_000);

  it('pergunta sem caminho de dado → admite não saber e oferece humano (replay)', async () => {
    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .chamaTool('buscar_conhecimento', { pergunta: 'política de pets no resort' })
      .respondeTexto(
        'Não encontrei essa informação na nossa base. Quer que eu acione um atendente humano para te ajudar?',
      );

    await enviarPeloSimulador(WA_ID_VINCULADO, 'posso levar meu cachorro para o resort?');
    const { resposta, trace } = await aguardarResposta();

    const toolResult = fake.requests[2]?.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toBe('{"rows":[],"truncated":false}'); // KB vazia ⇒ [] honesto
    expect(resposta).toMatch(/atendente humano/);
    expect(trace.resposta).toBe(resposta);
  }, 20_000);

  it('trace_turno reconstitui a decisão inteira', async () => {
    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .chamaTool('meu_produto', {})
      .respondeTexto('Sua cota é DIAMANTE PREMIUM, com 2 períodos de uso por ano!');
    await enviarPeloSimulador(WA_ID_VINCULADO, 'o que eu comprei mesmo?');
    const { trace } = await aguardarResposta();

    const contexto = trace.contexto as { tools: string[]; nMensagensHistorico: number };
    expect(contexto.tools).toContain('saldo_contrato');
    expect(contexto.tools).toContain('escalar_para_humano');
    const eventos = trace.eventos as {
      tipo: string;
      resultado?: { rows: { tier?: string }[] };
    }[];
    const evTool = eventos.find((e) => e.tipo === 'tool');
    // resultado REAL do seed reconstituível no trace (contrato demo 10001)
    expect(evTool?.resultado?.rows[0]?.tier).toBe('DIAMANTE PREMIUM');
    expect(trace.tokensEntrada).toBeGreaterThan(0);
    expect(trace.latenciaMs).toBeGreaterThanOrEqual(0);
    expect(trace.traceId).toMatch(/^[0-9a-f-]{36}$/);
  }, 20_000);

  it('wa_id SEM vínculo: tools de dado NEM SÃO EXPOSTAS ao modelo (#35)', async () => {
    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .respondeTexto('Não localizei seu cadastro por aqui. Quer que eu acione um atendente?');

    await enviarPeloSimulador('5511888880000', 'quanto falta pagar do meu contrato?');
    const { trace } = await aguardarResposta();

    // spec 003: sem vínculo na sessão, o modelo só vê KB + escalar — nada de
    // colher erros de tool de dado
    const contexto = trace.contexto as { tools: string[] };
    expect(contexto.tools).toEqual(['buscar_conhecimento', 'escalar_para_humano']);
  }, 20_000);

  it('contexto usa as N mensagens mais RECENTES e enxerga respostas do atendente', async () => {
    // conversa longeva: mais mensagens que a janela de contexto (fix do review)
    const conversaId = newTraceId();
    await db.insert(conversa).values({ id: conversaId, waId: WA_ID_VINCULADO });
    const max = clientConfig.limites.maxMensagensContexto;
    const base = Date.now() - 600_000;
    for (let i = 1; i <= max + 5; i++) {
      await db.insert(mensagem).values({
        id: newTraceId(),
        conversaId,
        direcao: 'in',
        autor: 'contato',
        texto: `msg-${i}`,
        status: 'recebida',
        criadoEm: new Date(base + i * 1000),
      });
    }
    // mensagem manual do atendente: turno_id NULL — antes do fix era invisível
    await db.insert(mensagem).values({
      id: newTraceId(),
      conversaId,
      direcao: 'out',
      autor: 'atendente',
      texto: 'combinei reenvio da nota fiscal',
      status: 'enviada',
      criadoEm: new Date(base + (max + 6) * 1000),
    });

    fake.respondeTexto('outro').respondeTexto('Perfeito, seguimos de onde paramos!');
    await enviarPeloSimulador(WA_ID_VINCULADO, 'continuando nossa conversa');
    await aguardarResposta();

    const conteudos = (fake.requests[1]?.messages ?? []).map((m) => String(m.content));
    expect(conteudos.some((c) => c.includes('combinei reenvio da nota fiscal'))).toBe(true);
    expect(conteudos.some((c) => c.includes(`msg-${max + 5}`))).toBe(true); // recente entra
    expect(conteudos.some((c) => c === 'msg-1')).toBe(false); // antiga sai da janela
  }, 20_000);

  it('#28: turnos de conversas DIFERENTES processam em paralelo', async () => {
    // provider-barreira: a resposta do grafo só libera quando DOIS turnos
    // estiverem em voo ao mesmo tempo — com processamento serial, trava e o
    // teste falha por timeout (era o comportamento antigo)
    let emVoo = 0;
    let liberar: () => void = () => {};
    const barreira = new Promise<void>((r) => {
      liberar = r;
    });
    const provider = {
      modelId: 'barreira',
      embed: async (t: readonly string[]) => t.map(() => new Float32Array(8)),
      chat: async (req: { messages: readonly { content: string }[] }) => {
        const ehClassificador = String(req.messages[0]?.content).startsWith('Classifique');
        if (!ehClassificador) {
          emVoo += 1;
          if (emVoo >= 2) liberar();
          await barreira;
        }
        return {
          content: ehClassificador ? 'outro' : 'tudo certo!',
          toolCalls: [],
          tokensEntrada: 1,
          tokensSaida: 1,
          finishReason: 'stop',
        };
      },
    };
    fake = provider as unknown as typeof fake;

    await enviarPeloSimulador('5511999990005', 'oi, tudo bem?');
    await enviarPeloSimulador('5511999990006', 'bom dia!');
    await aguardar(
      async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) === 2,
      20_000,
    );
    expect(emVoo).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
