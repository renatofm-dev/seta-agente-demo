import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import { and, count, eq, isNull } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  casoEval,
  chunk,
  conversa,
  documento,
  eventoLlm,
  eventoQuery,
  eventoTicket,
  mensagem,
  outbox,
  proposta,
  sinalAprendizado,
  skill,
  skillVersao,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createDrizzleObsEmitter } from '../src/obs-emitter.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { createSkillRegistry } from '../src/skills/registry.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Critérios da spec 009 (Ato 3): sinais → gerar → aprovar → skill no contexto;
 * imutabilidade/rollback; rejeição→sinal; kill-switch; cadeia de auditoria.
 */

const DEBOUNCE_MS = 400;
const WA_ID = '5511999990001';
const logger = createLogger({ name: 'teste-aprendizado', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let registry: ReturnType<typeof createSkillRegistry>;
let store: ReturnType<typeof createPgVectorStore>;
let fake = createFakeProvider();
// referência ESTÁVEL: as rotas capturam o provider no register; o proxy delega ao fake corrente
const providerProxy = {
  modelId: 'proxy-fake',
  chat: (req: Parameters<typeof fake.chat>[0]) => fake.chat(req),
  embed: (t: readonly string[]) => fake.embed(t),
};
let cookieCurador = '';
let cookieAtendente = '';

const clientConfig = loadClientConfig(
  join(import.meta.dirname, '../../../configs/demo/client.yaml'),
);
const catalog = loadCatalog(join(import.meta.dirname, '../../../catalog'));

const PROPOSTA_DISTILLER = {
  proposta: {
    name: 'responder-pedido-desconto',
    description: 'Como responder pedidos de desconto sem negociar e escalando com empatia.',
    gatilho: 'cliente pede desconto, abatimento ou condicao especial',
    tools: ['escalar_para_humano'],
    corpo:
      'Quando o cliente pedir desconto:\n1. Nunca prometa valores.\n2. Explique que a tabela é única.\n3. Acione escalar_para_humano com o motivo.',
  },
};

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
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

async function apiCurador(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie: cookieCurador },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function turnoCompleto(texto: string): Promise<typeof traceTurno.$inferSelect> {
  const antes = (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie: cookieAtendente }, // simulador exige sessão (011)
    payload: { waId: WA_ID, text: texto },
  });
  expect(res.statusCode).toBe(202);
  await aguardar(
    async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) > antes,
  );
  const traces = await db.select().from(traceTurno).orderBy(traceTurno.criadoEm);
  const ultimo = traces.at(-1);
  if (!ultimo) throw new Error('sem trace');
  return ultimo;
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
      SKILLS_SEED_DIR: join(import.meta.dirname, '../../../skills-seed'),
      EMBEDDING_DIM: '8', // fake provider embeda em 8 dims
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
  store = createPgVectorStore({ db, dim: env.EMBEDDING_DIM });
  // chunks de outra dimensão (ex.: dev com modelo real) quebrariam a recriação do índice
  await db.delete(chunk);
  await db.delete(documento);
  await store.ensureIndex();
  registry = createSkillRegistry({ db, store, embed: null });
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
      provider: providerProxy,
      catalog,
      executor,
      clientConfig,
      registry,
      store,
      obs: createNoopObsEmitter(),
      logger,
      turnoTimeoutMs: 30_000,
      resumoACadaTurnos: 99,
    }),
    logger,
  });
  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    console: {
      auth,
      executor,
      registry,
      provider: providerProxy,
      obs: createDrizzleObsEmitter(db, logger), // #30: tokens do distiller
    },
  });

  const curador = USUARIOS_DEMO[1];
  const atendente = USUARIOS_DEMO[0];
  cookieCurador = await login(curador?.email ?? '', curador?.password ?? '');
  cookieAtendente = await login(atendente?.email ?? '', atendente?.password ?? '');
}, 60_000);

beforeEach(async () => {
  fake = createFakeProvider();
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  // turno em voo do teste anterior pode gravar trace no meio da limpeza (FK);
  // com as filas já limpas, repetir a limpeza resolve na 2ª tentativa
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(casoEval);
      await db.delete(eventoLlm);
      await db.delete(chunk);
      await db.delete(documento);
      await db.delete(skillVersao);
      await db.delete(proposta);
      await db.delete(skill);
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
  // repõe as skills do seed (o beforeEach limpa tudo)
  await seedApp(db, env);
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('critérios spec 009 (Ato 3)', () => {
  it('sinais → gerar → aprovar → skill influencia a resposta seguinte (trace)', async () => {
    // 1) sinais reais: pedido de desconto escala via classificador (006/007)
    fake.respondeTexto('negociar_preco');
    await turnoCompleto('me dá 10% de desconto no fardo?');
    // sinais são gravados APÓS o trace — aguarda estabilizar (verdict + escalonamento)
    await aguardar(
      async () => ((await db.select({ n: count() }).from(sinalAprendizado))[0]?.n ?? 0) >= 2,
    );
    const sinais = await db.select().from(sinalAprendizado);

    // 2) gerar propostas (distiller com saída estruturada; 1 cluster rende proposta)
    fake = createFakeProvider();
    for (let i = 0; i < 8; i++)
      fake.enfileira({
        content: JSON.stringify(i === 0 ? PROPOSTA_DISTILLER : { proposta: null }),
        toolCalls: [],
      });
    const gerar = await apiCurador('POST', '/api/aprendizado/gerar');
    expect(gerar.statusCode, gerar.body).toBe(200);
    expect(gerar.json().propostasCriadas).toBe(1);
    expect(gerar.json().sinaisProcessados).toBeGreaterThanOrEqual(sinais.length);
    // #30: a chamada do distiller entra no evento_llm (fora de conversa)
    await aguardar(async () => {
      const rows = await db.select().from(eventoLlm).where(isNull(eventoLlm.conversaId));
      return rows.length >= 1;
    });
    const [evDistiller] = await db.select().from(eventoLlm).where(isNull(eventoLlm.conversaId));
    expect(evDistiller?.tokensEntrada).toBe(10);
    expect(evDistiller?.turnoId).toBeNull();

    // proposta com evidência + caso_eval do trace real
    const propostas = await apiCurador('GET', '/api/aprendizado/propostas');
    expect(propostas.json()).toHaveLength(1);
    expect(propostas.json()[0].impactoConversas).toBeGreaterThanOrEqual(1);
    expect((await db.select({ n: count() }).from(casoEval))[0]?.n).toBe(1);

    // 3) curador aprova → versão ativa carimbada
    const propostaId = propostas.json()[0].id;
    const aprovar = await apiCurador('POST', `/api/aprendizado/proposta/${propostaId}/aprovar`);
    expect(aprovar.statusCode).toBe(200);
    const [versaoNova] = await db
      .select()
      .from(skillVersao)
      .where(eq(skillVersao.id, aprovar.json().versaoId));
    expect(versaoNova?.status).toBe('ativa');
    expect(versaoNova?.aprovadoPor).toBe(USUARIOS_DEMO[1]?.email);
    // 008: ativação posiciona a skill no ns 'skills' do VectorStore
    const [chunkSkill] = await db
      .select()
      .from(chunk)
      .where(and(eq(chunk.ns, 'skills'), eq(chunk.id, versaoNova?.skillId ?? '')));
    expect(chunkSkill?.fonte).toBe('responder-pedido-desconto');

    // 4) o ticket escalado precisa voltar ao bot para o próximo turno rodar
    const [tk] = await db.select().from(ticket);
    const devolver = await app.inject({
      method: 'POST',
      url: `/api/console/ticket/${tk?.id}/assumir`,
      headers: { cookie: cookieAtendente },
    });
    expect(devolver.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: `/api/console/ticket/${tk?.id}/resolver`,
      headers: { cookie: cookieAtendente },
    });

    // 5) turno seguinte: skill aprovado entra no contexto (verificável no trace)
    fake = createFakeProvider()
      .respondeTexto('outro')
      .respondeTexto('Nossa tabela é única, mas vou te passar para um atendente avaliar!');
    const trace = await turnoCompleto('e aquele desconto camarada, rola?');
    const contexto = trace.contexto as { skillIds: string[] };
    const [s] = await db
      .select()
      .from(skill)
      .where(eq(skill.idLogico, 'responder-pedido-desconto'));
    expect(contexto.skillIds).toContain(s?.id);
    // o corpo do skill chegou ao system prompt do modelo
    const system = fake.requests[1]?.messages[0];
    expect(system?.content).toContain('Nunca prometa valores');
  }, 30_000);

  it('versões imutáveis: aprovar edição cria versão nova; rollback reativa anterior', async () => {
    const [s] = await db
      .select()
      .from(skill)
      .where(eq(skill.idLogico, 'cobranca-boletos-vencidos'));
    if (!s) throw new Error('skill do seed ausente');
    const [v1] = await db.select().from(skillVersao).where(eq(skillVersao.skillId, s.id));
    expect(v1?.versao).toBe(1);

    // proposta de patch aprovada com edição → v2 ativa, v1 arquivada e INTACTA
    const { newTraceId } = await import('@seta/observability');
    const pid = newTraceId();
    await db.insert(proposta).values({
      id: pid,
      tipo: 'skill_patch',
      skillId: s.id,
      diff: 'Corpo proposto pelo distiller para a v2 com mais contexto de cobrança.',
      frontmatter: v1?.frontmatter ?? {},
      evidencia: { nConversas: 2 },
      sinais: [],
    });
    const aprovar = await apiCurador('POST', `/api/aprendizado/proposta/${pid}/aprovar`, {
      corpo: 'Corpo EDITADO pelo curador antes de aprovar — vale este texto aqui.',
    });
    expect(aprovar.statusCode).toBe(200);

    const versoes = await db.select().from(skillVersao).where(eq(skillVersao.skillId, s.id));
    expect(versoes).toHaveLength(2);
    const v1Depois = versoes.find((v) => v.versao === 1);
    const v2 = versoes.find((v) => v.versao === 2);
    expect(v1Depois?.status).toBe('arquivada');
    expect(v1Depois?.corpo).toBe(v1?.corpo); // imutável
    expect(v2?.status).toBe('ativa');
    expect(v2?.corpo).toContain('EDITADO pelo curador');

    // rollback 1 clique → v1 volta a ativa, v2 arquivada
    const rollback = await apiCurador('POST', `/api/aprendizado/skill/${s.id}/rollback`, {
      paraVersao: 1,
      motivo: 'v2 piorou a resposta',
    });
    expect(rollback.statusCode).toBe(204);
    const aposRollback = await db.select().from(skillVersao).where(eq(skillVersao.skillId, s.id));
    expect(aposRollback.find((v) => v.versao === 1)?.status).toBe('ativa');
    expect(aposRollback.find((v) => v.versao === 2)?.status).toBe('arquivada');
  }, 20_000);

  it('rejeição gera sinal; kill-switch remove do retrieval imediatamente', async () => {
    const { newTraceId } = await import('@seta/observability');
    // conversa para ancorar o sinal de rejeição
    const conversaId = newTraceId();
    await db.insert(conversa).values({ id: conversaId, waId: '5511888887777' });

    const pid = newTraceId();
    await db.insert(proposta).values({
      id: pid,
      tipo: 'skill_novo',
      diff: 'Corpo qualquer proposto que o curador vai rejeitar por baixa qualidade.',
      frontmatter: { name: 'skill-ruim', description: 'descrição de teste da proposta ruim' },
      evidencia: { conversaId, nConversas: 1 },
      sinais: [],
    });
    const rejeitar = await apiCurador('POST', `/api/aprendizado/proposta/${pid}/rejeitar`, {
      motivo: 'genérico demais, não ensina nada',
    });
    expect(rejeitar.statusCode).toBe(204);
    // #36: tipo próprio (auditável) que o distiller NÃO recicla em proposta nova
    const sinaisRejeicao = await db.select().from(sinalAprendizado);
    expect(sinaisRejeicao.some((sig) => sig.tipo === 'rejeicao_proposta')).toBe(true);

    // #36: rejeitar de novo (já rejeitada) não sobrescreve a auditoria
    const deNovo = await apiCurador('POST', `/api/aprendizado/proposta/${pid}/rejeitar`, {
      motivo: 'tentando de novo',
    });
    expect(deNovo.statusCode).toBeGreaterThanOrEqual(400);

    // kill-switch: skill do seed some do retrieval na hora
    const [s] = await db.select().from(skill).where(eq(skill.idLogico, 'status-pedido-proativo'));
    if (!s) throw new Error('skill do seed ausente');
    const antes = await registry.activeFor(
      { texto: 'cadê meu pedido, quando chega a entrega?' },
      2,
    );
    expect(antes.some((a) => a.skillId === s.id)).toBe(true);
    const desativar = await apiCurador('POST', `/api/aprendizado/skill/${s.id}/desativar`, {
      motivo: 'skill dando resposta errada na demo',
    });
    expect(desativar.statusCode).toBe(204);
    const depois = await registry.activeFor(
      { texto: 'cadê meu pedido, quando chega a entrega?' },
      2,
    );
    expect(depois.some((a) => a.skillId === s.id)).toBe(false);
    // 008: kill-switch também removeu o vetor do ns 'skills'
    const restos = await db
      .select()
      .from(chunk)
      .where(and(eq(chunk.ns, 'skills'), eq(chunk.id, s.id)));
    expect(restos).toHaveLength(0);
  }, 20_000);

  it('#36: JSON inválido do distiller NÃO consome os sinais (ficam pendentes)', async () => {
    fake = createFakeProvider().respondeTexto('negociar_preco'); // classificador escala → gera sinais
    await turnoCompleto('quero um desconto agressivo');
    await aguardar(
      async () =>
        (await db.select().from(sinalAprendizado).where(isNull(sinalAprendizado.processadoEm)))
          .length > 0,
    );
    const pendentesAntes = await db
      .select()
      .from(sinalAprendizado)
      .where(isNull(sinalAprendizado.processadoEm));

    fake = createFakeProvider();
    for (let i = 0; i < 6; i++) fake.respondeTexto(`resposta sem json nenhum ${i} 🙃`);
    const gerar = await apiCurador('POST', '/api/aprendizado/gerar');
    expect(gerar.statusCode).toBe(200);
    expect(gerar.json().propostasCriadas).toBe(0);
    expect(gerar.json().sinaisProcessados).toBe(0); // nada foi consumido às cegas

    const pendentesDepois = await db
      .select()
      .from(sinalAprendizado)
      .where(isNull(sinalAprendizado.processadoEm));
    expect(pendentesDepois.length).toBe(pendentesAntes.length); // prontos p/ retry
  }, 30_000);

  it('#32: sincronizar não re-embeda inalteradas nem apaga vetor bom', async () => {
    let chamadas = 0;
    const regComEmbed = createSkillRegistry({
      db,
      store,
      embed: async (texto) => {
        chamadas += 1;
        return Array.from((await fake.embed([texto]))[0] ?? []);
      },
    });
    await regComEmbed.sincronizar(); // 1ª: skills do seed ainda sem vetor → embeda
    const primeira = chamadas;
    expect(primeira).toBeGreaterThan(0);
    await regComEmbed.sincronizar(); // 2ª: nada mudou → ZERO chamadas de API
    expect(chamadas).toBe(primeira);

    // API de embedding fora do ar no boot NÃO apaga vetor bom
    const regQuebrado = createSkillRegistry({
      db,
      store,
      embed: async () => {
        throw new Error('api de embedding fora do ar');
      },
    });
    await regQuebrado.sincronizar();
    const vetores = await db.select().from(chunk).where(eq(chunk.ns, 'skills'));
    expect(vetores.length).toBeGreaterThan(0);
    expect(vetores.every((c) => c.embedding !== null)).toBe(true);
  }, 20_000);

  it('papel curador é obrigatório; cadeia de auditoria navegável', async () => {
    const comoAtendente = await app.inject({
      method: 'GET',
      url: '/api/aprendizado/propostas',
      headers: { cookie: cookieAtendente },
    });
    expect(comoAtendente.statusCode).toBe(403);

    // monta cadeia: sinal → proposta → aprovação → versão → turno que usou
    fake.respondeTexto('negociar_preco');
    await turnoCompleto('desconto no barril?');
    fake = createFakeProvider();
    for (let i = 0; i < 8; i++)
      fake.enfileira({
        content: JSON.stringify(i === 0 ? PROPOSTA_DISTILLER : { proposta: null }),
        toolCalls: [],
      });
    await apiCurador('POST', '/api/aprendizado/gerar');
    const [p] = await db.select().from(proposta).where(eq(proposta.status, 'aberta'));
    await apiCurador('POST', `/api/aprendizado/proposta/${p?.id}/aprovar`);
    const [s] = await db
      .select()
      .from(skill)
      .where(eq(skill.idLogico, 'responder-pedido-desconto'));

    const auditoria = await apiCurador('GET', `/api/aprendizado/skill/${s?.id}/auditoria`);
    expect(auditoria.statusCode).toBe(200);
    const cadeia = auditoria.json().cadeia[0];
    expect(cadeia.versao.aprovadoPor).toBe(USUARIOS_DEMO[1]?.email);
    expect(cadeia.proposta.id).toBe(p?.id);
    expect(cadeia.sinais.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
