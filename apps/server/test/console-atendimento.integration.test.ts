import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { count, desc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  conversa,
  conversaLeitura,
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
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { registerOutboxWorker } from '../src/wa/outbox.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios do #45 (atendimento estilo WhatsApp Web): listagem por conversa
 * (1 query, busca, filtros), não-lidas por atendente, thread paginada,
 * prefixo *Nome* na resposta do atendente (sem repetir em consecutivas),
 * orçamento de caracteres e bloqueio explícito da janela de 24h.
 * Exige Postgres dev.
 */

const DEBOUNCE_MS = 400;
const WA_VINCULADO = '5511999990001'; // contrato 10001 no contatos.yaml
const WA_SEM_VINCULO = '5511888880000';

const logger = createLogger({ name: 'teste-console-45', level: 'silent' });
let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();
let cookieAtendente = '';
let cookieCurador = '';
let atendenteId = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));
const NOME_ATENDENTE = USUARIOS_DEMO[0]?.name ?? '';

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

async function mensagemDoContato(waId: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie: cookieAtendente },
    payload: { waId, text },
  });
  expect(res.statusCode).toBe(202);
}

async function apiConsole(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  cookie = cookieAtendente,
) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  return (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Turno completo do bot: classificador 'outro' + resposta simples. */
async function turnoDoBot(waId: string, textoContato: string, respostaBot: string) {
  const antes = (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
  fake = createFakeProvider().respondeTexto('outro').respondeTexto(respostaBot);
  await mensagemDoContato(waId, textoContato);
  await aguardar(
    async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) > antes,
  );
}

/** Espera o worker do outbox entregar tudo (mensagens `out` são assíncronas). */
async function aguardarSaidasEntregues() {
  await aguardar(async () => {
    const linhas = await db.select({ status: outbox.status }).from(outbox);
    return linhas.length > 0 && linhas.every((l) => l.status !== 'pendente');
  });
}

/** Escala a conversa do waId via classificador (negociar_preco). */
async function escalar(waId: string, textoContato: string) {
  fake = createFakeProvider().respondeTexto('negociar_preco');
  await mensagemDoContato(waId, textoContato);
  await aguardar(async () => {
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
    if (!conv) return false;
    const [t] = await db.select().from(ticket).where(eq(ticket.conversaId, conv.id));
    return t?.status === 'aguardando_humano';
  });
  const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
  const [t] = await db
    .select()
    .from(ticket)
    .where(eq(ticket.conversaId, conv?.id ?? ''));
  if (!conv || !t) throw new Error('escalada não materializou');
  return { conversaId: conv.id, ticketId: t.id };
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
      EMBEDDING_DIM: '8',
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
  const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL });

  boss = await startBoss(env.DATABASE_URL, logger);
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    ticketGate: (conversaId) => ticketPermiteBot(db, conversaId),
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
    }),
    logger,
  });
  let seqEnvio = 0;
  await registerOutboxWorker({
    db,
    boss,
    logger,
    gateway: {
      async send() {
        seqEnvio += 1;
        return { waMessageId: `wamid.c45-${seqEnvio}` };
      },
    },
  });
  app = buildApp({ env, clientConfig, wa: { db, boss }, console: { auth, executor } });

  const atendente = USUARIOS_DEMO[0];
  const curador = USUARIOS_DEMO[1];
  cookieAtendente = await login(atendente?.email ?? '', atendente?.password ?? '');
  cookieCurador = await login(curador?.email ?? '', curador?.password ?? '');
  const me = await apiConsole('GET', '/api/console/me');
  atendenteId = me.json().userId;
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(conversaLeitura);
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

describe('#45 — listagem por conversa', () => {
  it('lista TODAS as conversas (não só escaladas), ordenadas pela última mensagem', async () => {
    await turnoDoBot(WA_VINCULADO, 'oi', 'Olá! Sou o assistente do resort.');
    await turnoDoBot(WA_SEM_VINCULO, 'bom dia', 'Bom dia! Não localizei seu cadastro.');
    await aguardarSaidasEntregues();

    const res = await apiConsole('GET', '/api/console/conversas');
    expect(res.statusCode).toBe(200);
    const { conversas } = res.json();
    expect(conversas).toHaveLength(2);
    // conversas em bot_ativo APARECEM (antes o console só via escaladas)
    expect(conversas.every((c: { status: string }) => c.status === 'bot_ativo')).toBe(true);
    const vinculada = conversas.find((c: { waId: string }) => c.waId === WA_VINCULADO);
    expect(vinculada.contatoNome).toBe('Contrato 10001'); // apelido do vínculo
    expect(vinculada.janelaExpiraEm).toBeTruthy();
    expect(vinculada.ultimaMensagem).toBeTruthy();

    // ordenação: mensagem nova (do contato, síncrona) põe a conversa no topo
    fake = createFakeProvider().respondeTexto('outro').respondeTexto('Sim!');
    await mensagemDoContato(WA_VINCULADO, 'mais uma coisa');
    const depois = await apiConsole('GET', '/api/console/conversas');
    expect(depois.json().conversas[0].waId).toBe(WA_VINCULADO);
    expect(depois.json().conversas[1].waId).toBe(WA_SEM_VINCULO);
  }, 30_000);

  it('busca por nome e por telefone; filtros aguardando/minhas/resolvidas', async () => {
    await turnoDoBot(WA_VINCULADO, 'oi', 'Olá!');
    await turnoDoBot(WA_SEM_VINCULO, 'oi', 'Olá!');

    const porNome = await apiConsole('GET', '/api/console/conversas?q=Contrato%2010001');
    expect(porNome.json().conversas).toHaveLength(1);
    expect(porNome.json().conversas[0].waId).toBe(WA_VINCULADO);

    const porFone = await apiConsole('GET', '/api/console/conversas?q=(88888)');
    expect(porFone.json().conversas).toHaveLength(1);
    expect(porFone.json().conversas[0].waId).toBe(WA_SEM_VINCULO);

    // escala a vinculada → filtro aguardando
    const { ticketId } = await escalar(WA_VINCULADO, 'me dá um desconto?');
    const aguardando = await apiConsole('GET', '/api/console/conversas?filtro=aguardando');
    expect(aguardando.json().conversas).toHaveLength(1);
    expect(aguardando.json().conversas[0].status).toBe('aguardando_humano');
    expect(aguardando.json().conversas[0].motivoEscalonamento).toBeTruthy();

    // assumir → minhas (com nome de quem atende)
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/assumir`)).statusCode).toBe(
      200,
    );
    const minhas = await apiConsole('GET', '/api/console/conversas?filtro=minhas');
    expect(minhas.json().conversas).toHaveLength(1);
    expect(minhas.json().conversas[0].atendenteNome).toBe(NOME_ATENDENTE);
    // "minhas" é por usuário: para o curador, vazio
    const minhasDoCurador = await apiConsole(
      'GET',
      '/api/console/conversas?filtro=minhas',
      undefined,
      cookieCurador,
    );
    expect(minhasDoCurador.json().conversas).toHaveLength(0);

    // resolver → resolvidas
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/resolver`)).statusCode).toBe(
      200,
    );
    const resolvidas = await apiConsole('GET', '/api/console/conversas?filtro=resolvidas');
    expect(resolvidas.json().conversas).toHaveLength(1);
  }, 30_000);

  it('não-lidas por atendente: zeram ao marcar lida e voltam a contar; outro usuário mantém as dele', async () => {
    await turnoDoBot(WA_VINCULADO, 'primeira pergunta', 'Resposta 1');
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, WA_VINCULADO));
    const conversaId = conv?.id ?? '';

    const antes = await apiConsole('GET', '/api/console/conversas');
    expect(antes.json().conversas[0].naoLidas).toBe(1);

    expect((await apiConsole('POST', `/api/console/conversa/${conversaId}/lida`)).statusCode).toBe(
      200,
    );
    const depois = await apiConsole('GET', '/api/console/conversas');
    expect(depois.json().conversas[0].naoLidas).toBe(0);

    // o curador NÃO marcou: continua vendo 1 não lida (leitura é por atendente)
    const doCurador = await apiConsole('GET', '/api/console/conversas', undefined, cookieCurador);
    expect(doCurador.json().conversas[0].naoLidas).toBe(1);

    // mensagem nova volta a contar para quem já tinha lido
    await turnoDoBot(WA_VINCULADO, 'segunda pergunta', 'Resposta 2');
    const comNova = await apiConsole('GET', '/api/console/conversas');
    expect(comNova.json().conversas[0].naoLidas).toBe(1);
  }, 30_000);
});

describe('#45 — detalhe da conversa e thread paginada', () => {
  it('detalhe traz ticket, janela, limite e mensagens; antesDe pagina sem recarregar o resto', async () => {
    await turnoDoBot(WA_VINCULADO, 'pergunta 1', 'resposta 1');
    await turnoDoBot(WA_VINCULADO, 'pergunta 2', 'resposta 2');
    await turnoDoBot(WA_VINCULADO, 'pergunta 3', 'resposta 3');
    await aguardarSaidasEntregues(); // 3 in + 3 out persistidas = thread de 6
    await aguardar(async () => ((await db.select({ n: count() }).from(mensagem))[0]?.n ?? 0) === 6);
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, WA_VINCULADO));
    const conversaId = conv?.id ?? '';

    const res = await apiConsole('GET', `/api/console/conversa/${conversaId}?limite=4`);
    expect(res.statusCode).toBe(200);
    const detalhe = res.json();
    expect(detalhe.ticket.status).toBe('bot_ativo');
    expect(detalhe.limiteResposta).toBe(clientConfig.limites.maxCaracteresResposta);
    expect(detalhe.janelaExpiraEm).toBeTruthy();
    expect(detalhe.mensagens).toHaveLength(4); // as 4 mais recentes, em ordem cronológica
    expect(detalhe.temMais).toBe(true);
    const [antiga, ...resto] = detalhe.mensagens;
    expect(
      resto.every(
        (m: { criadoEm: string }, i: number) =>
          new Date(m.criadoEm) >= new Date((i === 0 ? antiga : resto[i - 1]).criadoEm),
      ),
    ).toBe(true);

    const pagina = await apiConsole(
      'GET',
      `/api/console/conversa/${conversaId}?limite=4&antesDe=${encodeURIComponent(antiga.criadoEm)}`,
    );
    expect(pagina.statusCode).toBe(200);
    expect(pagina.json().mensagens).toHaveLength(2); // sobraram as 2 primeiras
    expect(pagina.json().temMais).toBe(false);
    expect(pagina.json().ticket).toBeUndefined(); // página antiga é só thread
  }, 30_000);

  it('conversa inexistente → 404 (detalhe e lida)', async () => {
    const fantasma = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect((await apiConsole('GET', `/api/console/conversa/${fantasma}`)).statusCode).toBe(404);
    expect((await apiConsole('POST', `/api/console/conversa/${fantasma}/lida`)).statusCode).toBe(
      404,
    );
  });
});

describe('#45 — prefixo do atendente na mensagem entregue', () => {
  it('1ª resposta leva *Nome* no topo; consecutivas do MESMO atendente não; bot no meio reabre', async () => {
    const { ticketId, conversaId } = await escalar(WA_VINCULADO, 'quero desconto');
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/assumir`)).statusCode).toBe(
      200,
    );

    // 1ª resposta: prefixo obrigatório (última saída foi do bot/nenhuma)
    const r1 = await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: 'Bom dia! Vou verificar seu caso.',
      chave: 'chave-prefixo-1',
    });
    expect(r1.statusCode).toBe(202);
    const [saida1] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.conversaId, conversaId))
      .orderBy(desc(outbox.criadoEm))
      .limit(1);
    expect(saida1?.texto).toBe(`*${NOME_ATENDENTE}*\n\nBom dia! Vou verificar seu caso.`);
    expect(saida1?.atendenteId).toBe(atendenteId);

    // 2ª consecutiva do mesmo atendente: SEM prefixo
    const r2 = await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: 'Só um instante.',
      chave: 'chave-prefixo-2',
    });
    expect(r2.statusCode).toBe(202);
    const [saida2] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.conversaId, conversaId))
      .orderBy(desc(outbox.criadoEm))
      .limit(1);
    expect(saida2?.texto).toBe('Só um instante.');

    // a mensagem PERSISTIDA é a entregue (com prefixo) e carrega o atendente
    await aguardar(async () =>
      (await db.select().from(mensagem)).some((m) => m.autor === 'atendente'),
    );
    const enviadas = await db.select().from(mensagem).where(eq(mensagem.conversaId, conversaId));
    const doAtendente = enviadas.filter((m) => m.autor === 'atendente');
    expect(doAtendente.some((m) => m.texto.startsWith(`*${NOME_ATENDENTE}*\n\n`))).toBe(true);
    expect(doAtendente.every((m) => m.atendenteId === atendenteId)).toBe(true);
    // e a do bot NUNCA leva prefixo
    const doBot = enviadas.filter((m) => m.autor === 'bot');
    expect(doBot.every((m) => !m.texto.startsWith('*'))).toBe(true);

    // devolve ao bot; bot fala; nova escalada + resposta → prefixo VOLTA
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/devolver`)).statusCode).toBe(
      200,
    );
    await turnoDoBot(WA_VINCULADO, 'ainda to esperando', 'Já te atualizo por aqui!');
    await escalar(WA_VINCULADO, 'quero desconto de novo');
    expect((await apiConsole('POST', `/api/console/ticket/${ticketId}/assumir`)).statusCode).toBe(
      200,
    );
    const r3 = await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: 'Voltei com novidades.',
      chave: 'chave-prefixo-3',
    });
    expect(r3.statusCode).toBe(202);
    const [saida3] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.conversaId, conversaId))
      .orderBy(desc(outbox.criadoEm))
      .limit(1);
    expect(saida3?.texto).toBe(`*${NOME_ATENDENTE}*\n\nVoltei com novidades.`);
  }, 30_000);

  it('orçamento: texto + prefixo acima de maxCaracteresResposta → 400 com explicação', async () => {
    const { ticketId } = await escalar(WA_VINCULADO, 'desconto?');
    await apiConsole('POST', `/api/console/ticket/${ticketId}/assumir`);

    const teto = clientConfig.limites.maxCaracteresResposta;
    const quaseNoLimite = 'a'.repeat(teto - 5); // sozinho passa; com prefixo estoura
    const res = await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: quaseNoLimite,
      chave: 'chave-orcamento-1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().erro).toMatch(/limite.*caracteres/);
    // nada do ATENDENTE enfileirado (a transição do bot da escalada não conta)
    const saidas = await db.select().from(outbox).where(eq(outbox.autor, 'atendente'));
    expect(saidas).toHaveLength(0);
  }, 30_000);
});

describe('#45 — janela de 24h no envio manual', () => {
  it('janela fechada → 409 explicado ANTES de enfileirar (nada de falha silenciosa)', async () => {
    const { ticketId, conversaId } = await escalar(WA_VINCULADO, 'desconto?');
    await apiConsole('POST', `/api/console/ticket/${ticketId}/assumir`);

    await db
      .update(conversa)
      .set({ janelaExpiraEm: new Date(Date.now() - 60_000) })
      .where(eq(conversa.id, conversaId));

    const res = await apiConsole('POST', `/api/console/ticket/${ticketId}/responder`, {
      texto: 'essa não deveria sair',
      chave: 'chave-janela-1',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().erro).toMatch(/janela de 24h/);
    const saidas = await db.select().from(outbox).where(eq(outbox.autor, 'atendente'));
    expect(saidas).toHaveLength(0);

    // o detalhe expõe a janela para a interface bloquear ANTES do erro
    const detalhe = await apiConsole('GET', `/api/console/conversa/${conversaId}`);
    expect(new Date(detalhe.json().janelaExpiraEm).getTime()).toBeLessThan(Date.now());
  }, 30_000);
});
