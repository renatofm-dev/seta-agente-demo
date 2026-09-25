import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import { createErpSimulado, type ErpSimulado } from '@seta/erp-api-tse';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import type { JanelaInfo, OutboundDocument, OutboundGateway } from '@seta/wa-meta';
import { asc, count, eq } from 'drizzle-orm';
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
  conversaLeitura,
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
import { enviarLinha, TEXTO_ANEXO_INDISPONIVEL } from '../src/wa/outbox.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * 040 — a 2ª via de boleto em PDF, do pedido no WhatsApp até o arquivo saindo
 * pelo gateway.
 *
 * O que estes casos protegem, em uma frase: **o PDF não passa pelo modelo e
 * nenhuma falha vira silêncio**. O agente escolhe QUAL parcela; quem confere se
 * ela é do contrato da conversa, quem busca o arquivo e quem entrega é o
 * servidor — e quando o ERP não tem o boleto, um humano fica sabendo.
 */

const DEBOUNCE_MS = 400;
/** Contrato 10002: tem parcelas com boleto E uma no cartão recorrente (sem). */
const WA_ID = '5511999990002';
const CONTRATO = '10002';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const logger = createLogger({ name: 'teste-040', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let fake = createFakeProvider();
let erp: ErpSimulado;
let enviados: { doc: OutboundDocument; janela: JanelaInfo }[] = [];
let textos: string[] = [];
let gateway: OutboundGateway;
/**
 * Parcelas do seed usadas pelos casos, resolvidas no beforeAll. De cada uma
 * guardamos as DUAS faces: o `id` da linha, que é o que o servidor usa para
 * buscar o PDF e o que os asserts conferem no anexo, e o NÚMERO da parcela,
 * que é o único que o modelo manipula desde que a tool deixou de pedir id.
 */
let tituloComBoleto = '';
let numComBoleto = '';
let numCartao = '';
let numBoletoNaoGerado = '';
/** Número que NÃO existe em aberto neste contrato — `max(parcela) + 1`. */
let numInexistente = '';

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

async function enviarPeloSimulador(text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    payload: { waId: WA_ID, text },
  });
  expect(res.statusCode).toBe(202);
}

/** O trace é a ÚLTIMA escrita do turno — esperar por ele evita corrida. */
async function aguardarTurno(): Promise<void> {
  await aguardar(async () => ((await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0) === 1);
}

async function linhasOutbox() {
  return db.select().from(outbox).orderBy(asc(outbox.seq));
}

/** O que o modelo recebeu de volta da tool — é onde o ok=false aparece. */
function ultimaRespostaDeTool(): string {
  const req = fake.requests.at(-1);
  const tool = [...(req?.messages ?? [])].reverse().find((m) => m.role === 'tool');
  return tool?.content ?? '';
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

  /**
   * `status <> 'pago'` em todas: é o recorte de `financeiro.parcela_por_numero`.
   * Uma fixture paga passaria no SELECT daqui e não existiria para a tool.
   */
  const parcela = async (sql: string, params: unknown[]): Promise<[string, string]> => {
    const { rows } = await admin.query<{ id: string; parcela: number }>(sql, params);
    return [String(rows[0]?.id ?? ''), String(rows[0]?.parcela ?? '')];
  };
  // a mais PRÓXIMA: a mais distante é a que perde a linha digitável logo abaixo
  [tituloComBoleto, numComBoleto] = await parcela(
    `SELECT id, parcela FROM v_titulo WHERE contrato_id = $1 AND linha_digitavel IS NOT NULL
        AND status <> 'pago'
      ORDER BY vencimento ASC LIMIT 1`,
    [CONTRATO],
  );
  // duas maneiras de não ter boleto, e o agente precisa saber diferenciá-las
  [, numCartao] = await parcela(
    `SELECT id, parcela FROM v_titulo WHERE contrato_id = $1 AND meio_pagamento = 'cartao_recorrente'
        AND status <> 'pago' LIMIT 1`,
    [CONTRATO],
  );
  /**
   * "Boleto ainda não gerado" não existe no seed em parcela ABERTA — as sem
   * linha digitável são todas pagas, e pagas não entram na consulta da tool.
   * Então a fixture é fabricada aqui: a parcela mais distante do contrato perde
   * a linha digitável. É a mais distante de propósito: as próximas são as que
   * a demo usa.
   */
  const { rows: semLinha } = await admin.query<{ id: string; parcela: number }>(
    `UPDATE contafinanceira SET linhadigitavel = NULL
      WHERE idcontafinanceira = (
        SELECT id::int FROM v_titulo
         WHERE contrato_id = $1 AND meio_pagamento = 'boleto' AND status <> 'pago'
         ORDER BY vencimento DESC LIMIT 1)
      RETURNING idcontafinanceira::text AS id, numeroparcela AS parcela`,
    [CONTRATO],
  );
  numBoletoNaoGerado = String(semLinha[0]?.parcela ?? '');
  const { rows: maiores } = await admin.query<{ proxima: string }>(
    `SELECT (max(parcela) + 1)::text AS proxima FROM v_titulo WHERE contrato_id = $1`,
    [CONTRATO],
  );
  numInexistente = String(maiores[0]?.proxima ?? '');
  expect(
    tituloComBoleto && numComBoleto && numCartao && numBoletoNaoGerado && numInexistente,
  ).toBeTruthy();

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

  erp = createErpSimulado();
  gateway = {
    async send(msg) {
      textos.push(msg.body);
      return { waMessageId: `txt-${textos.length}` };
    },
    async sendTemplate() {
      return { waMessageId: 'tpl' };
    },
    async sendDocument(doc, janela) {
      enviados.push({ doc, janela });
      return { waMessageId: `doc-${enviados.length}` };
    },
  };

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
      anexos: erp, // 040
    }),
    logger,
  });
  app = buildApp({ env, clientConfig, wa: { db, boss } });
}, 90_000);

beforeEach(async () => {
  fake = createFakeProvider();
  erp = createErpSimulado();
  erp.semearBoleto(tituloComBoleto, PDF);
  enviados = [];
  textos = [];
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(chunk);
      await db.delete(documento);
      // `sinal_aprendizado` referencia `ticket`: sem apagar antes, a limpeza
      // quebra por FK quando a suíte anterior (aprendizado) deixou sinais
      await db.delete(sinalAprendizado);
      await db.delete(eventoTicket);
      await db.delete(ticket);
      await db.delete(traceTurno);
      await db.delete(eventoQuery);
      await db.delete(outbox);
      await db.delete(mensagem);
      await db.delete(turno);
      await db.delete(conversaLeitura);
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

/**
 * `erp` é recriado a cada teste, então o worker recebe o do momento — e não o
 * que existia quando o handler foi montado.
 */
const depsWorker = () => ({ db, boss, gateway, logger, anexos: erp });

describe('040: o cotista pede a 2ª via e o boleto chega', () => {
  it('a tool confere a parcela, o servidor entrega o PDF e o modelo nunca o vê', async () => {
    fake
      .respondeTexto('outro') // classificador de intenção (006)
      .chamaTool('enviar_segunda_via', { parcela: numComBoleto })
      .respondeTexto('Claro! Já estou te enviando o boleto.');

    await enviarPeloSimulador('me manda a segunda via do meu boleto');
    await aguardarTurno();

    // duas linhas: a frase do agente (seq 1) e o documento logo depois (seq 2)
    const linhas = await linhasOutbox();
    expect(linhas).toHaveLength(2);
    expect(linhas[0]?.anexo).toBeNull();
    expect(linhas[1]?.seq).toBe(2);
    expect(linhas[1]?.anexo).toMatchObject({
      tipo: 'segunda_via',
      contaFinanceiraId: tituloComBoleto,
    });
    // a legenda usa o formatador da casa: `style: 'currency'` meteria um espaço
    // NÃO-QUEBRÁVEL entre `R$` e o número, e isso vaza para o WhatsApp
    expect(linhas[1]?.texto).toMatch(/2ª via da parcela \d+\/\d+, no valor de R\$ [\d.,]+/);
    expect(linhas[1]?.texto).not.toContain('\u00a0');
    expect(linhas[1]?.texto).toMatch(/vencimento em \d{2}\/\d{2}\/\d{4}\.$/);

    // o PDF não chegou perto do prompt: nem nos resultados de tool, nem no texto
    const prompts = JSON.stringify(fake.requests);
    expect(prompts).not.toContain('%PDF');
    expect(ultimaRespostaDeTool()).not.toContain('%PDF');

    await enviarLinha(depsWorker(), linhas[1]?.id ?? '');
    expect(enviados).toHaveLength(1);
    expect(Array.from(enviados[0]?.doc.bytes ?? [])).toEqual(Array.from(PDF));
    expect(enviados[0]?.doc.mime).toBe('application/pdf');
    // nome legível e único por vencimento — quem tem várias parcelas distingue
    expect(enviados[0]?.doc.filename).toMatch(/^boleto-parcela-\d{2,}-\d{8}\.pdf$/);
    expect(enviados[0]?.doc.caption).toBe(linhas[1]?.texto);

    // o trace guarda as DUAS mensagens: a frase do agente e a legenda do boleto
    const [trace] = await db.select().from(traceTurno);
    expect(trace?.resposta).toContain('Já estou te enviando o boleto.');
    expect(trace?.resposta).toContain('2ª via da parcela');

    // a mensagem no histórico registra QUAL arquivo saiu — é o que o console lê
    const msgs = await db
      .select()
      .from(mensagem)
      .where(eq(mensagem.direcao, 'out'))
      .orderBy(asc(mensagem.criadoEm));
    expect(msgs.at(-1)?.anexoNome).toBe(enviados[0]?.doc.filename);
  }, 30_000);

  /**
   * O turno inteiro, começando pelo CLASSIFICADOR — que é por onde a frase do
   * roteiro entra de verdade, e onde a 040 quase morreu: "me manda a segunda
   * via do meu boleto" caía em `pagar` (a descrição daquela categoria dizia
   * "pede boleto"), o turno terminava no fluxo de cobrança e a tool nunca era
   * alcançada, com a spec inteira implementada e testada por baixo.
   *
   * O que ESTE caso prova é a outra metade: que `segunda_via` não é
   * interceptada por nenhum ramo de fluxo e chega ao agente. Ele **não**
   * pegaria a regressão original — sem a categoria, `segunda_via` não faz parse
   * e o classificador cai em `outro`, que vai para o agente do mesmo jeito.
   * Quem trava a regressão é `guardrails.test.ts`, com a âncora de que a linha
   * `- pagar:` do prompt não pode mais falar em boleto.
   */
  it('a frase do roteiro chega ao agente, não ao fluxo de cobrança', async () => {
    fake
      .respondeTexto('segunda_via') // classificador — a categoria da 040
      .chamaTool('enviar_segunda_via', { parcela: numComBoleto })
      .respondeTexto('Claro! Já estou te enviando o boleto.');

    await enviarPeloSimulador('me manda a segunda via do meu boleto');
    await aguardarTurno();

    const linhas = await linhasOutbox();
    // o fluxo de cobrança responderia "Encontrei N parcela(s) em aberto"
    expect(linhas[0]?.texto).not.toMatch(/parcela\(s\) em aberto/);
    expect(linhas).toHaveLength(2);
    expect(linhas[1]?.anexo).toMatchObject({ contaFinanceiraId: tituloComBoleto });
  }, 30_000);

  it('reprocessar a MESMA linha não manda o boleto duas vezes', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numComBoleto })
      .respondeTexto('Já vai!');
    await enviarPeloSimulador('manda o boleto por favor');
    await aguardarTurno();

    const id = (await linhasOutbox())[1]?.id ?? '';
    await enviarLinha(depsWorker(), id);
    await enviarLinha(depsWorker(), id); // retry do pg-boss depois de já ter enviado
    expect(enviados).toHaveLength(1);
  }, 30_000);
});

describe('040: quando não dá, o agente explica — e nada é inventado', () => {
  it('parcela no cartão recorrente volta com o MOTIVO — o agente não precisa adivinhar', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numCartao })
      .respondeTexto('Essa parcela é no cartão recorrente, não tem boleto para segunda via.');

    await enviarPeloSimulador('me manda o boleto daquela parcela');
    await aguardarTurno();

    expect(ultimaRespostaDeTool()).toContain('"ok":false');
    expect(ultimaRespostaDeTool()).toMatch(/cart[aã]o recorrente/i);

    const linhas = await linhasOutbox();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.anexo).toBeNull();
  }, 30_000);

  it('parcela de boleto AINDA não gerado é caso diferente, e a resposta diz isso', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numBoletoNaoGerado })
      .respondeTexto('Essa parcela ainda não tem boleto emitido.');

    await enviarPeloSimulador('segunda via da próxima parcela');
    await aguardarTurno();

    expect(ultimaRespostaDeTool()).toContain('"ok":false');
    expect(ultimaRespostaDeTool()).toMatch(/não há boleto gerado/i);
    expect(await linhasOutbox()).toHaveLength(1);
  }, 30_000);

  /**
   * O caso antigo mandava o id de uma parcela de OUTRO contrato para provar o
   * bind de sessão. Com a tool recebendo NÚMERO, esse ataque deixou de existir:
   * `financeiro.parcela_por_numero` filtra por `contrato_id` de sessão, então
   * não há id a contrabandear. O que sobrou de errado que o modelo consegue
   * fazer é pedir um número que este contrato não tem — e aí a resposta tem de
   * ser "não achei", nunca um boleto parecido.
   */
  it('número que não existe no contrato volta ok=false — sem boleto aproximado', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numInexistente })
      .respondeTexto('Não achei essa parcela no seu contrato, me confirma qual é?');

    await enviarPeloSimulador('manda a segunda via');
    await aguardarTurno();

    expect(ultimaRespostaDeTool()).toContain('"ok":false');
    expect(ultimaRespostaDeTool()).toMatch(/não achei a parcela/i);
    expect(await linhasOutbox()).toHaveLength(1);
    expect(enviados).toHaveLength(0);
  }, 30_000);

  it('ERP sem o arquivo: a linha vira falha e um humano é chamado — nunca silêncio', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numComBoleto })
      .respondeTexto('Já estou te enviando.');
    await enviarPeloSimulador('segunda via do boleto');
    await aguardarTurno();

    const linha = (await linhasOutbox())[1];
    const semBoleto = createErpSimulado(); // nada semeado: o ERP não tem o PDF
    await enviarLinha({ db, boss, gateway, logger, anexos: semBoleto }, linha?.id ?? '');

    expect(enviados).toHaveLength(0);
    const [depois] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, linha?.id ?? ''));
    expect(depois?.status).toBe('falha');
    const [tk] = await db.select().from(ticket);
    expect(tk?.status).toBe('aguardando_humano');
    expect(tk?.motivoEscalonamento).toMatch(/boleto/i);

    // o agente ACABOU de prometer o arquivo: sumir depois disso é pior que
    // nunca ter oferecido, então sai uma mensagem honesta junto com o ticket
    const aviso = (await linhasOutbox()).find((l) => l.texto === TEXTO_ANEXO_INDISPONIVEL);
    expect(aviso).toBeDefined();
    expect(aviso?.anexo).toBeNull();
    expect(aviso?.dedupeKey).toBe(`bot:anexo-indisponivel:${linha?.id}`);
  }, 30_000);

  it('o aviso de falha não se repete quando a mesma linha é reprocessada', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numComBoleto })
      .respondeTexto('Já vai.');
    await enviarPeloSimulador('me manda o boleto');
    await aguardarTurno();

    const linha = (await linhasOutbox())[1];
    const semBoleto = createErpSimulado();
    const deps = { db, boss, gateway, logger, anexos: semBoleto };
    await enviarLinha(deps, linha?.id ?? '');
    // a linha já está em `falha`: o reprocesso sai cedo e não avisa de novo
    await enviarLinha(deps, linha?.id ?? '');

    const avisos = (await linhasOutbox()).filter((l) => l.texto === TEXTO_ANEXO_INDISPONIVEL);
    expect(avisos).toHaveLength(1);
  }, 30_000);

  it('sem resolvedor de anexo a entrega não acontece em silêncio — escala igual', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('enviar_segunda_via', { parcela: numComBoleto })
      .respondeTexto('Já vai.');
    await enviarPeloSimulador('quero a segunda via');
    await aguardarTurno();

    const linha = (await linhasOutbox())[1];
    await enviarLinha({ db, boss, gateway, logger }, linha?.id ?? '');

    expect(enviados).toHaveLength(0);
    expect(textos).toHaveLength(0); // e NÃO caiu para texto puro
    const [depois] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, linha?.id ?? ''));
    expect(depois?.status).toBe('falha');
  }, 30_000);
});
