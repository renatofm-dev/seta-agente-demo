import { join } from 'node:path';
import { createFakeProvider } from '@seta/ai-provider/testing';
import { loadClientConfig } from '@seta/client-config';
import {
  TEXTO_CANCELADO,
  TEXTO_INTERESSE_COMPRA,
  TEXTO_METODO,
  TEXTO_NAO_ENTENDI,
  TEXTO_RECUSADO,
  TEXTO_SEM_DOCUMENTO,
} from '@seta/cobranca';
import { createPgConnector, type DbConnector } from '@seta/erp-connector';
import { createLogger, createNoopObsEmitter } from '@seta/observability';
import { createSimulatedPaymentProvider } from '@seta/payment-provider';
import { createExecutor, type Executor, loadCatalog } from '@seta/query-catalog';
import type { OutboundTemplate } from '@seta/wa-meta';
import { asc, count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminUrl, applySchema, seedData } from '../../../infra/erp-mock/seed.ts';
import { type App, buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import {
  FILA_COBRANCA_EMITIR,
  FILA_COBRANCA_EVENTO,
  FILA_DEBOUNCE,
  FILA_OUTBOX,
  startBoss,
} from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  chunk,
  cobranca,
  cobrancaTitulo,
  contato,
  conversa,
  conversaLeitura,
  documento,
  eventoPsp,
  eventoQuery,
  eventoTicket,
  fluxoCobranca,
  mensagem,
  outbox,
  pagamento,
  pspCliente,
  sinalAprendizado,
  supressao,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { createExecutorConciliado } from '../src/pagamentos/conciliacao.ts';
import { registerCobrancaEmitirWorker } from '../src/pagamentos/emitir.ts';
import { registerCobrancaEventoWorker } from '../src/pagamentos/eventos.ts';
import { createPagamentosRepo } from '../src/pagamentos/repo.ts';
import { createDrizzleQueryEventSink } from '../src/query-event-sink.ts';
import { createPgVectorStore } from '../src/rag/pgvector-store.ts';
import { seedApp, USUARIOS_DEMO } from '../src/seed-app.ts';
import { registerDebounceWorker } from '../src/wa/debounce.ts';
import { suprimir } from '../src/wa/supressao.ts';
import { ticketPermiteBot } from '../src/wa/tickets.ts';
import { createAgentTurnoHandler } from '../src/wa/turno-handler.ts';

/**
 * Spec 014 — compra e cobrança pelo WhatsApp, ponta a ponta VIA SIMULADOR:
 * LLM fake (só o classificador e o fallback de interpretação), PSP simulado,
 * dados reais do ERP mock (spec 012) pelo catálogo, conciliação por cima.
 * Exige Postgres dev.
 */

const DEBOUNCE_MS = 300;
const WA_EM_DIA = '5511999990001'; // contrato 10001: ativo, em dia (só a próxima)
const WA_INADIMPLENTE = '5511999990002'; // contrato 10002: 3 vencidas + 1 recorrente vencida
const WA_DISTRATO = '5511999990003'; // contrato 10003: cancelado, distrato em análise
const WEBHOOK_TOKEN = 'token-de-teste-do-webhook-asaas-0123456789';
const logger = createLogger({ name: 'teste-cobranca', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
let app: App;
let admin: pg.Pool;
let connector: DbConnector;
let executor: Executor;
let cookie = '';
let fake = createFakeProvider();
const psp = createSimulatedPaymentProvider();
/** 043: templates que o gateway fake recebeu, por teste. */
const templatesEnviados: OutboundTemplate[] = [];
/** 043: o worker de eventos captura o env no registro — getter para trocar por teste. */
let templateConfirmado: string | undefined;
/** Mutável: os cenários de teto trocam o limite sem re-registrar o handler. */
let envPagamentos: Env;

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

async function enviar(waId: string, text: string) {
  // com o console registrado, /dev/* exige sessão (011)
  const res = await app.inject({
    method: 'POST',
    url: '/dev/inbound',
    headers: { cookie },
    payload: { waId, text },
  });
  expect(res.statusCode).toBe(202);
}

async function traces(): Promise<number> {
  return (await db.select({ n: count() }).from(traceTurno))[0]?.n ?? 0;
}

/** Manda uma mensagem e espera o turno fechar (trace é gravado por último). */
async function turnoDe(waId: string, text: string): Promise<string[]> {
  const antes = await traces();
  await enviar(waId, text);
  await aguardar(async () => (await traces()) === antes + 1);
  return textosSaida();
}

/** Todas as mensagens de saída, na ordem em que entraram no outbox. */
async function textosSaida(): Promise<string[]> {
  const linhas = await db.select().from(outbox).orderBy(asc(outbox.criadoEm), asc(outbox.seq));
  return linhas.map((l) => l.texto);
}

async function ultimaSaida(): Promise<string> {
  const todas = await textosSaida();
  return todas[todas.length - 1] ?? '';
}

async function apiConsole(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function cobrancaUnica() {
  const linhas = await db.select().from(cobranca);
  expect(linhas).toHaveLength(1);
  const c = linhas[0];
  if (!c) throw new Error('sem cobrança');
  return c;
}

/** Caminho comum: "quero pagar" (classificador fake) → lista → escolha → método → confirmação. */
async function fluxoAteConfirmar(waId: string, escolha: string, metodo: string) {
  fake.respondeTexto('pagar');
  const lista = await turnoDe(waId, 'quero pagar');
  expect(lista[lista.length - 1]).toContain('Qual você quer pagar');
  await turnoDe(waId, escolha);
  expect(await ultimaSaida()).toBe(TEXTO_METODO);
  await turnoDe(waId, metodo);
  expect(await ultimaSaida()).toContain('Posso gerar o pagamento?');
  await turnoDe(waId, 'sim');
}

/** 043: corpo de webhook "pago" para uma cobrança já emitida. */
function eventoPago(
  c: { pspCobrancaId: string | null; valorCentavos: number; referenciaExterna: string },
  id: string,
) {
  return {
    id,
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: c.pspCobrancaId,
      status: 'RECEIVED',
      value: c.valorCentavos / 100,
      externalReference: c.referenciaExterna,
      paymentDate: '2026-09-15',
    },
  };
}

async function webhook(body: unknown, token = WEBHOOK_TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/asaas',
    headers: { 'asaas-access-token': token },
    payload: body,
  });
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
      ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      // 043: com os modelos configurados, a emissão anexa o template à linha 1
      WA_TEMPLATE_COBRANCA_BOLETO: 'cobranca_boleto',
      WA_TEMPLATE_BOLETO_SEGUNDA_VIA: 'boleto_segunda_via',
      WA_TEMPLATE_COBRANCA_CARTAO: 'cobranca_cartao',
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };
  envPagamentos = env;
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  await seedApp(db, env);

  connector = createPgConnector({ url: env.ERP_DATABASE_URL, poolMax: 3 });
  const repo = createPagamentosRepo(db);
  executor = createExecutorConciliado(
    createExecutor({ catalog, connector, sink: createDrizzleQueryEventSink(db) }),
    repo,
  );
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
      debounceMs: DEBOUNCE_MS,
      pagamentos: {
        repo,
        psp,
        get env() {
          return envPagamentos;
        },
      },
    }),
    logger,
  });
  await registerCobrancaEmitirWorker({
    db,
    boss,
    repo,
    psp,
    logger,
    nomeCliente: clientConfig.nome,
    env,
    pixRecebedor: { merchantName: 'SETA TECH LTDA', key: 'chave-pix-teste', keyType: 'EVP' }, // 043
  });
  // 043: o fake precisa REGISTRAR — sem isso não dá para asserir o ramo de
  // template de `notificarPago`, que é o que os critérios 4 e 5 exigem.
  const gatewayFake = {
    async send() {
      return { waMessageId: 'wamid.x' };
    },
    async sendTemplate(msg: OutboundTemplate) {
      templatesEnviados.push(msg);
      return { waMessageId: `wamid.tpl-${templatesEnviados.length}` };
    },
  };
  await registerCobrancaEventoWorker({
    db,
    boss,
    repo,
    gateway: gatewayFake,
    env: {
      get WA_TEMPLATE_PAGAMENTO_CONFIRMADO() {
        return templateConfirmado;
      },
    },
    logger,
  });

  app = buildApp({
    env,
    clientConfig,
    wa: { db, boss },
    // 044: `erp` destrava as rotas de campanha de cobrança
    console: { auth, executor, erp: connector },
    pagamentos: { repo, psp },
  });

  const atendente = USUARIOS_DEMO[0];
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: atendente?.email, password: atendente?.password },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
}, 60_000);

beforeEach(async () => {
  templatesEnviados.length = 0;
  templateConfirmado = undefined;
  fake = createFakeProvider();
  envPagamentos = env;
  for (const fila of [FILA_DEBOUNCE, FILA_OUTBOX, FILA_COBRANCA_EMITIR, FILA_COBRANCA_EVENTO]) {
    await boss.deleteQueuedJobs(fila);
  }
  for (let tentativa = 0; ; tentativa++) {
    try {
      // 044: supressão de um teste não pode vazar para o próximo — foi assim
      // que a campanha apareceu com tudo "suprimido" na primeira rodada
      await db.delete(supressao);
      await db.delete(pagamento);
      await db.delete(cobrancaTitulo);
      await db.delete(fluxoCobranca);
      await db.delete(cobranca);
      await db.delete(eventoPsp);
      await db.delete(pspCliente);
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
  // a suíte é serial: cobrança pendurada na conversa impede o `delete from
  // conversa` das outras suítes pela FK. O beforeEach limpa no INÍCIO de cada
  // teste, então sem isto o último caso do arquivo deixa lixo para o próximo.
  // o beforeEach limpa no INÍCIO de cada teste, então sem isto o último caso do
  // arquivo deixa lixo para a próxima suíte: cobrança pendurada na conversa
  // trava o `delete from conversa` pela FK, e a conversa recente vira
  // `conversas[0]` na listagem do console-atendimento.
  await db?.delete(pagamento);
  await db?.delete(cobrancaTitulo);
  await db?.delete(fluxoCobranca);
  await db?.delete(cobranca);
  await db?.delete(eventoPsp);
  await db?.delete(pspCliente);
  for (const waId of [WA_EM_DIA, WA_INADIMPLENTE, WA_DISTRATO]) {
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
    if (!conv) continue;
    await db.delete(traceTurno).where(eq(traceTurno.conversaId, conv.id));
    await db.delete(eventoTicket);
    await db.delete(ticket).where(eq(ticket.conversaId, conv.id));
    await db.delete(outbox).where(eq(outbox.conversaId, conv.id));
    await db.delete(mensagem).where(eq(mensagem.conversaId, conv.id));
    await db.delete(turno).where(eq(turno.conversaId, conv.id));
    await db.delete(conversa).where(eq(conversa.id, conv.id));
  }
  await app?.close();
  await boss?.stop({ graceful: false });
  await connector?.close();
  await closeDb?.();
  await admin?.end();
});

describe('spec 014 — compra e cobrança pelo WhatsApp', () => {
  it('caminho feliz: lista → escolhe → PIX → confirma → emitida (2 msgs) → reaproveita → paga → conciliação', async () => {
    const criadasAntes = psp.chamadas.criarCobranca;

    // 1) "quero pagar" do inadimplente: vencidas do ERP + próxima + "todas"
    fake.respondeTexto('pagar');
    const [lista] = await turnoDe(WA_INADIMPLENTE, 'quero pagar');
    expect(lista).toContain('Encontrei');
    expect(lista).toContain('venceu em');
    expect(lista).toContain('Todas as vencidas');
    expect(lista).toContain('Qual você quer pagar');
    expect(fake.requests).toHaveLength(1); // só o classificador — o fluxo não gasta LLM

    // 2) escolhe a 1ª (mais antiga) → método → confirmação com valor do ERP
    await turnoDe(WA_INADIMPLENTE, '1');
    expect(await ultimaSaida()).toBe(TEXTO_METODO);
    await turnoDe(WA_INADIMPLENTE, '2');
    const confirmacao = await ultimaSaida();
    expect(confirmacao).toContain('Forma: PIX');
    expect(confirmacao).toMatch(/Total: R\$ \d/);
    expect(fake.requests).toHaveLength(1); // "1", "2": parser determinístico

    // 3) confirma: cobrança emitindo → worker → emitida + 2 mensagens (texto + código)
    await turnoDe(WA_INADIMPLENTE, 'sim');
    expect(await ultimaSaida()).toContain('gerando seu PIX');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    expect(c.metodo).toBe('pix');
    expect(c.pspCobrancaId).toMatch(/^sim_pay_/);
    expect(c.pixCopiaCola).toMatch(/^00020126/);
    expect(c.referenciaExterna).toMatch(/^contrato:10002:titulos:\d+$/);
    const titulos = await db.select().from(cobrancaTitulo);
    expect(titulos).toHaveLength(1);
    expect(titulos[0]?.valorCentavos).toBe(c.valorCentavos);
    expect(confirmacao).toContain(
      `R$ ${(c.valorCentavos / 100)
        .toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`,
    );
    await aguardar(async () => (await textosSaida()).some((t) => t.startsWith('00020126')));
    const saidas = await textosSaida();
    expect(saidas.find((t) => t.includes('Seu PIX está pronto'))).toBeTruthy();
    expect(saidas[saidas.length - 1]).toBe(c.pixCopiaCola);
    expect(psp.chamadas.criarCobranca).toBe(criadasAntes + 1);

    // 4) pedir de novo as MESMAS parcelas no mesmo método ⇒ reenvio, sem 2ª cobrança
    await fluxoAteConfirmar(WA_INADIMPLENTE, '1', 'pix');
    expect(await ultimaSaida()).toBe(c.pixCopiaCola);
    expect((await textosSaida()).some((t) => t.includes('reenviando'))).toBe(true);
    expect(await db.select().from(cobranca)).toHaveLength(1);
    expect(psp.chamadas.criarCobranca).toBe(criadasAntes + 1);

    // 5) simular pagamento (PSP simulado injeta o evento no caminho do webhook)
    const sim = await apiConsole('POST', `/api/console/cobrancas/${c.id}/simular-pagamento`);
    expect(sim.statusCode).toBe(202);
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'paga');
    const pagos = await db.select().from(pagamento);
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({
      contratoId: '10002',
      tituloId: titulos[0]?.tituloId,
      valorCentavos: c.valorCentavos,
      metodo: 'pix',
      status: 'confirmado',
    });
    await aguardar(async () => (await ultimaSaida()).includes('Pagamento confirmado'));
    // esperar o artefato que o assert lê: `notificarPago` enfileira o outbox de
    // DENTRO de `marcarPaga`, e `concluir` só grava processado_em depois disso —
    // aguardar pelo texto abre uma corrida (é o flake conhecido deste arquivo).
    await aguardar(async () => (await db.select().from(eventoPsp))[0]?.processadoEm !== null);
    const [ev] = await db.select().from(eventoPsp);
    expect(ev?.processadoEm).not.toBeNull();

    // 6) conciliação: "o que está vencido?" pelo agente geral não vê mais o título pago
    fake
      .respondeTexto('outro')
      .chamaTool('titulos_atraso', {})
      .respondeTexto('Você tem parcelas em aberto, te passo a lista.');
    await turnoDe(WA_INADIMPLENTE, 'o que está vencido?');
    const toolMsg = fake.requests[fake.requests.length - 1]?.messages.find(
      (m) => m.role === 'tool',
    );
    const rows = JSON.parse(toolMsg?.content ?? '{}').rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => String(r.id) === titulos[0]?.tituloId)).toBe(false);
    expect(rows[0]?.qtd_titulos_vencidos).toBe(rows.length);
    // e o console lista a cobrança paga
    const consoleRes = await apiConsole('GET', '/api/console/cobrancas');
    expect(consoleRes.statusCode).toBe(200);
    const body = consoleRes.json();
    expect(body.psp).toBe('simulado');
    expect(body.contagens.paga).toBe(1);
    expect(body.cobrancas[0].parcelas).toMatch(/parcela \d+/);
  }, 60_000);

  it('"todas as vencidas" no boleto: total somado, linha digitável na 2ª mensagem', async () => {
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', 'boleto');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    const titulos = await db.select().from(cobrancaTitulo);
    expect(titulos.length).toBeGreaterThanOrEqual(2);
    expect(c.valorCentavos).toBe(titulos.reduce((acc, t) => acc + t.valorCentavos, 0));
    await aguardar(async () => /^\d{47}$/.test(await ultimaSaida()));
    expect(await ultimaSaida()).toBe(c.linhaDigitavel);
    expect((await textosSaida()).some((t) => t.includes('Seu boleto está pronto'))).toBe(true);
  }, 30_000);

  it('contrato cancelado/em distrato: bloqueia, explica e escala (cobranca_bloqueada)', async () => {
    fake.respondeTexto('pagar');
    const [texto] = await turnoDe(WA_DISTRATO, 'quero pagar');
    expect(texto).toContain('cancelado');
    expect(texto).toContain('já acionei a equipe');
    const [tk] = await db.select().from(ticket);
    expect(tk?.status).toBe('aguardando_humano');
    const [sinal] = await db.select().from(sinalAprendizado);
    expect((sinal?.payload as { trigger?: string } | undefined)?.trigger).toBe(
      'cobranca_bloqueada',
    );
    expect(await db.select().from(cobranca)).toHaveLength(0);
    const [trace] = await db.select().from(traceTurno);
    expect(trace?.escalado).toBe(true);
  });

  it('acima do teto: aguarda aprovação + ticket; aprovar no console emite; recusar encerra', async () => {
    envPagamentos = { ...env, PAGAMENTO_TETO_SEM_HITL_CENTAVOS: 100 };
    await fluxoAteConfirmar(WA_INADIMPLENTE, '1', 'cartão');
    expect(await ultimaSaida()).toContain('aprovação de um atendente');
    const c = await cobrancaUnica();
    expect(c.status).toBe('aguardando_aprovacao');
    const [tk] = await db.select().from(ticket);
    expect(tk?.status).toBe('aguardando_humano');
    expect(tk?.motivoEscalonamento).toContain('acima do teto');

    const lista = await apiConsole('GET', '/api/console/cobrancas?status=aguardando_aprovacao');
    expect(lista.json().cobrancas).toHaveLength(1);

    const aprovar = await apiConsole('POST', `/api/console/cobrancas/${c.id}/aprovar`);
    expect(aprovar.statusCode).toBe(202);
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const emitida = await cobrancaUnica();
    expect(emitida.aprovadoPor).toBeTruthy();
    expect(emitida.urlFatura).toContain('pagamento.simulado');
    await aguardar(async () => (await ultimaSaida()).includes('link de pagamento está pronto'));
    expect((await apiConsole('POST', `/api/console/cobrancas/${c.id}/aprovar`)).statusCode).toBe(
      409,
    );

    // recusar: outra seleção (a 2ª parcela) para não reaproveitar a emitida. O
    // ticket segue aguardando_humano — o bot continua atendendo nessa fila (#47)
    await fluxoAteConfirmar(WA_INADIMPLENTE, '2', 'pix');
    const pendente = (await db.select().from(cobranca)).find(
      (x) => x.status === 'aguardando_aprovacao',
    );
    expect(pendente).toBeTruthy();
    const recusar = await apiConsole('POST', `/api/console/cobrancas/${pendente?.id}/recusar`, {
      motivo: 'valor precisa de conferência',
    });
    expect(recusar.statusCode).toBe(200);
    const [recusada] = await db
      .select()
      .from(cobranca)
      .where(eq(cobranca.id, pendente?.id ?? ''));
    expect(recusada?.status).toBe('recusada');
    expect(recusada?.motivo).toBe('valor precisa de conferência');
    expect(await ultimaSaida()).toBe(TEXTO_RECUSADO);
  }, 60_000);

  it('duas respostas não entendidas: re-pergunta, depois sai da frente e o agente geral responde', async () => {
    fake.respondeTexto('pagar');
    await turnoDe(WA_INADIMPLENTE, 'quero pagar');
    // 1ª: parser não resolve ⇒ LLM interpreta ⇒ nao_entendi ⇒ re-pergunta
    fake.respondeTexto('{"acao":"nao_entendi"}');
    await turnoDe(WA_INADIMPLENTE, 'hmm sei lá');
    expect(await ultimaSaida()).toBe(TEXTO_NAO_ENTENDI);
    // 2ª: abandona em silêncio; o MESMO turno segue para o agente geral (classificador + resposta)
    fake
      .respondeTexto('{"acao":"nao_entendi"}')
      .respondeTexto('outro')
      .respondeTexto('Claro! Posso te ajudar com outra coisa?');
    await turnoDe(WA_INADIMPLENTE, 'qual o horário da central?');
    expect(await ultimaSaida()).toBe('Claro! Posso te ajudar com outra coisa?');
    const [fluxo] = await db.select().from(fluxoCobranca);
    expect(fluxo?.etapa).toBe('encerrado');
    expect(fluxo?.encerramento).toBe('abandonado');
    const system = fake.requests[fake.requests.length - 1]?.messages[0]?.content ?? '';
    expect(system).toContain('fluxo de pagamento que foi encerrado');
    expect(await db.select().from(cobranca)).toHaveLength(0);
  }, 30_000);

  it('"cancelar" encerra com texto; sem CPF no vínculo bloqueia e escala', async () => {
    fake.respondeTexto('pagar');
    await turnoDe(WA_INADIMPLENTE, 'quero pagar');
    await turnoDe(WA_INADIMPLENTE, 'deixa pra lá');
    expect(await ultimaSaida()).toBe(TEXTO_CANCELADO);
    expect((await db.select().from(fluxoCobranca))[0]?.encerramento).toBe('cancelado');

    await db.update(contato).set({ documento: null }).where(eq(contato.waId, WA_EM_DIA));
    try {
      fake.respondeTexto('pagar');
      await turnoDe(WA_EM_DIA, 'quero pagar a próxima parcela');
      expect(await ultimaSaida()).toBe(TEXTO_SEM_DOCUMENTO);
      const [tk] = await db.select().from(ticket).where(eq(ticket.status, 'aguardando_humano'));
      expect(tk).toBeTruthy();
    } finally {
      await db.update(contato).set({ documento: '52998224725' }).where(eq(contato.waId, WA_EM_DIA));
    }
  }, 30_000);

  it('agente geral entrega ao fluxo pela tool iniciar_pagamento: frase (seq 1) + lista (seq 2) no mesmo turno', async () => {
    fake
      .respondeTexto('outro')
      .chamaTool('iniciar_pagamento', {})
      .respondeTexto('Claro! Vou verificar suas pendências.');
    await turnoDe(WA_EM_DIA, 'quero quitar minha próxima parcela');
    const linhas = await db.select().from(outbox).orderBy(asc(outbox.seq));
    expect(linhas.map((l) => l.seq)).toEqual([1, 2]);
    expect(linhas[0]?.texto).toBe('Claro! Vou verificar suas pendências.');
    // 10001 está em dia: 1 candidato (a próxima) ⇒ já pergunta o método
    expect(linhas[1]?.texto).toContain('Seu contrato está em dia');
    expect(linhas[1]?.texto).toContain(TEXTO_METODO);
    const [fluxo] = await db.select().from(fluxoCobranca);
    expect(fluxo?.etapa).toBe('metodo');
    const [trace] = await db.select().from(traceTurno);
    const eventos = trace?.eventos as { tipo: string }[];
    expect(eventos.some((e) => e.tipo === 'cobranca')).toBe(true);
    // e continua normalmente no turno seguinte
    await turnoDe(WA_EM_DIA, '3');
    expect(await ultimaSaida()).toContain('Forma: link de cartão');
  }, 30_000);

  it('webhook do Asaas: token inválido não tem efeito; evento idempotente; paga e estorna', async () => {
    // token errado ⇒ 401 sem linha
    const semToken = await webhook(
      { id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'x' } },
      'errado',
    );
    expect(semToken.statusCode).toBe(401);
    expect(await db.select().from(eventoPsp)).toHaveLength(0);
    // sem token configurado ⇒ 503 (app à parte)
    const appSemToken = buildApp({
      env: { ...env, ASAAS_WEBHOOK_TOKEN: undefined },
      clientConfig,
      wa: { db, boss },
      pagamentos: { repo: createPagamentosRepo(db), psp },
    });
    const r503 = await appSemToken.inject({ method: 'POST', url: '/webhooks/asaas', payload: {} });
    expect(r503.statusCode).toBe(503);
    await appSemToken.close();

    // cobrança emitida de verdade pelo fluxo (cartão, "todas")
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', '3');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    const pago = {
      id: 'evt_pago_1',
      event: 'PAYMENT_RECEIVED',
      dateCreated: '2026-09-02 10:00:00',
      payment: {
        id: c.pspCobrancaId,
        status: 'RECEIVED',
        value: c.valorCentavos / 100,
        externalReference: c.referenciaExterna,
        paymentDate: '2026-09-02',
      },
    };
    expect((await webhook(pago)).statusCode).toBe(200);
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'paga');
    const titulos = await db.select().from(cobrancaTitulo);
    expect(await db.select().from(pagamento)).toHaveLength(titulos.length);

    // reentrega do MESMO evento ⇒ 200 duplicado, nada muda
    const dup = await webhook(pago);
    expect(dup.json()).toEqual({ recebido: true, duplicado: true });
    expect(await db.select().from(eventoPsp)).toHaveLength(1);
    expect(await db.select().from(pagamento)).toHaveLength(titulos.length);

    // estorno reverte a baixa
    const estorno = { ...pago, id: 'evt_estorno_1', event: 'PAYMENT_REFUNDED' };
    expect((await webhook(estorno)).statusCode).toBe(200);
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'estornada');
    const pagos = await db.select().from(pagamento);
    expect(pagos.every((p) => p.status === 'estornado')).toBe(true);
    // e a conciliação volta a mostrar os títulos como vencidos
    fake.respondeTexto('outro').chamaTool('titulos_atraso', {}).respondeTexto('Lista.');
    await turnoDe(WA_INADIMPLENTE, 'o que está vencido?');
    const toolMsg = fake.requests[fake.requests.length - 1]?.messages.find(
      (m) => m.role === 'tool',
    );
    const rows = JSON.parse(toolMsg?.content ?? '{}').rows as Record<string, unknown>[];
    expect(rows.length).toBe(titulos.length);

    // corpo inválido ⇒ 400; evento de cobrança desconhecida ⇒ 200 e marcado com erro
    expect((await webhook({ nada: true })).statusCode).toBe(400);
    expect(
      (await webhook({ id: 'evt_x', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_nao_existe' } }))
        .statusCode,
    ).toBe(200);
    await aguardar(async () => {
      const [ev] = await db.select().from(eventoPsp).where(eq(eventoPsp.id, 'evt_x'));
      return ev?.erro === 'cobrança desconhecida';
    });
  }, 60_000);

  it('042: evento preso aparece como pendente, o reprocesso conclui e repetir é no-op', async () => {
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', '2');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();

    // o evento chega antes de a cobrança ser resolvível ⇒ fica com erro e SEM processado_em.
    // A reentrega do Asaas bate no onConflictDoNothing por id: sem a rota, fica preso para sempre.
    const corpo = {
      id: 'evt_preso&1', // o id do Asaas é text e contém `&` — nunca uuid
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_ainda_nao_conhecido',
        status: 'RECEIVED',
        value: c.valorCentavos / 100,
        paymentDate: '2026-09-02',
      },
    };
    expect((await webhook(corpo)).statusCode).toBe(200);
    await aguardar(async () => {
      const [ev] = await db.select().from(eventoPsp).where(eq(eventoPsp.id, 'evt_preso&1'));
      return ev?.erro === 'cobrança desconhecida' && ev?.processadoEm === null;
    });
    expect((await webhook(corpo)).json()).toEqual({ recebido: true, duplicado: true });

    // o console enxerga: lista de pendentes + contagem na tela de cobranças
    const pendentes = await apiConsole('GET', '/api/console/eventos-psp?pendente=true');
    expect(pendentes.statusCode).toBe(200);
    expect(pendentes.json().pendentes).toBe(1);
    expect(pendentes.json().eventos[0]).toMatchObject({
      id: 'evt_preso&1',
      erro: 'cobrança desconhecida',
      cobrancaId: null, // órfão: nenhum drawer de cobrança o alcançaria
    });
    const lista = await apiConsole('GET', '/api/console/cobrancas');
    expect(lista.json().eventosPspPendentes).toBe(1);

    // a causa desaparece (a cobrança passa a resolver) e o reprocesso conclui
    await db
      .update(cobranca)
      .set({ pspCobrancaId: 'pay_ainda_nao_conhecido' })
      .where(eq(cobranca.id, c.id));
    const reproc = await apiConsole(
      'POST',
      `/api/console/eventos-psp/${encodeURIComponent('evt_preso&1')}/reprocessar`,
    );
    expect(reproc.statusCode).toBe(202);
    expect(reproc.json()).toEqual({ ok: true, reenfileirado: true });
    // esperar o artefato que o assert lê: `concluir` grava processado_em DEPOIS
    // de marcarPaga, então aguardar por status='paga' abriria uma corrida.
    await aguardar(async () => {
      const [ev] = await db.select().from(eventoPsp).where(eq(eventoPsp.id, 'evt_preso&1'));
      return ev?.processadoEm !== null;
    });
    expect((await db.select().from(cobranca))[0]?.status).toBe('paga');
    const [concluido] = await db.select().from(eventoPsp).where(eq(eventoPsp.id, 'evt_preso&1'));
    expect(concluido?.processadoEm).not.toBeNull();
    expect(concluido?.erro).toBeNull();
    const pagosDepois = await db.select().from(pagamento);

    // repetir é no-op, não conflito: o estado desejado já vale
    const denovo = await apiConsole(
      'POST',
      `/api/console/eventos-psp/${encodeURIComponent('evt_preso&1')}/reprocessar`,
    );
    expect(denovo.statusCode).toBe(200);
    expect(denovo.json()).toMatchObject({ ok: true, reenfileirado: false });
    expect(await db.select().from(pagamento)).toHaveLength(pagosDepois.length);

    // evento que não existe ⇒ 404
    const ausente = await apiConsole('POST', '/api/console/eventos-psp/evt_nao_existe/reprocessar');
    expect(ausente.statusCode).toBe(404);

    const zerado = await apiConsole('GET', '/api/console/cobrancas');
    expect(zerado.json().eventosPspPendentes).toBe(0);
  }, 60_000);

  it('042: payload inválido é terminal — reprocessar não o ressuscita', async () => {
    await db.insert(eventoPsp).values({
      id: 'evt_lixo&1',
      psp: 'asaas',
      tipo: 'PAYMENT_RECEIVED',
      pspCobrancaId: null,
      payload: { formato: 'de outra versão' },
    });
    await boss.send(FILA_COBRANCA_EVENTO, { eventoId: 'evt_lixo&1' });
    await aguardar(async () => {
      const [ev] = await db.select().from(eventoPsp).where(eq(eventoPsp.id, 'evt_lixo&1'));
      return ev?.erro === 'payload inválido';
    });
    // terminal: o payload está gravado e não muda, então não fica na fila de pendentes
    const [ev] = await db.select().from(eventoPsp).where(eq(eventoPsp.id, 'evt_lixo&1'));
    expect(ev?.processadoEm).not.toBeNull();
    const pendentes = await apiConsole('GET', '/api/console/eventos-psp?pendente=true');
    expect(pendentes.json().pendentes).toBe(0);
    const r = await apiConsole(
      'POST',
      `/api/console/eventos-psp/${encodeURIComponent('evt_lixo&1')}/reprocessar`,
    );
    expect(r.json()).toMatchObject({ reenfileirado: false });
  }, 30_000);

  it('interesse em cota nova: texto próprio + escalada interesse_compra (não é "outro canal")', async () => {
    fake.respondeTexto('comprar_cota');
    const [texto] = await turnoDe(WA_EM_DIA, 'quero comprar mais uma cota');
    expect(texto).toBe(TEXTO_INTERESSE_COMPRA);
    const [tk] = await db.select().from(ticket);
    expect(tk?.status).toBe('aguardando_humano');
    const [trace] = await db.select().from(traceTurno);
    expect(trace?.escalado).toBe(true);
    const [sinal] = await db.select().from(sinalAprendizado);
    expect((sinal?.payload as { trigger?: string } | undefined)?.trigger).toBe('interesse_compra');
  });
  it('043: janela ABERTA ⇒ confirmação em texto livre pelo outbox, sem template', async () => {
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', '2');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    expect((await webhook(eventoPago(c, 'evt_ja_1'))).statusCode).toBe(200);
    await aguardar(async () => (await ultimaSaida()).includes('Pagamento confirmado'));
    expect(templatesEnviados).toHaveLength(0);
  }, 60_000);

  it('043: janela FECHADA + modelo configurado ⇒ confirmação por template', async () => {
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', '2');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    // fecha a janela e liga o modelo só para este teste
    await db
      .update(conversa)
      .set({ janelaExpiraEm: new Date(Date.now() - 60_000) })
      .where(eq(conversa.id, c.conversaId));
    templateConfirmado = 'pagamento_confirmado';

    expect((await webhook(eventoPago(c, 'evt_jf_1'))).statusCode).toBe(200);
    await aguardar(async () => templatesEnviados.length > 0);
    expect(templatesEnviados[0]).toMatchObject({
      nome: 'pagamento_confirmado',
      idioma: 'pt_BR',
      variaveis: ['R$ 4.623,00'],
    });
    // e a mensagem fica na thread, para o console mostrar o que o cotista viu
    const msgs = await db.select().from(mensagem).where(eq(mensagem.conversaId, c.conversaId));
    expect(msgs.some((m) => m.waMessageId?.startsWith('wamid.tpl-'))).toBe(true);
  }, 60_000);

  it('043: janela FECHADA e SEM modelo ⇒ nada é enviado e nada quebra (critério 5)', async () => {
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', '2');
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    await db
      .update(conversa)
      .set({ janelaExpiraEm: new Date(Date.now() - 60_000) })
      .where(eq(conversa.id, c.conversaId));
    templateConfirmado = undefined;

    expect((await webhook(eventoPago(c, 'evt_jf_2'))).statusCode).toBe(200);
    // a baixa acontece do mesmo jeito — o aviso é que não sai
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'paga');
    expect(templatesEnviados).toHaveLength(0);
  }, 60_000);
  it('043: emissão de boleto anexa o template de boleto à linha 1 do outbox', async () => {
    await fluxoAteConfirmar(WA_INADIMPLENTE, 'todas', '1'); // 1 = boleto
    await aguardar(async () => (await db.select().from(cobranca))[0]?.status === 'emitida');
    const c = await cobrancaUnica();
    expect(c.linhaDigitavel).toBeTruthy();

    const linhas = await db
      .select()
      .from(outbox)
      .where(eq(outbox.conversaId, c.conversaId))
      .orderBy(asc(outbox.criadoEm));
    const comTemplate = linhas.filter((l) => l.template !== null);
    // só a linha 1 carrega template: a 2 é a linha digitável crua, que já viaja
    // dentro do corpo do template — anexar nela abriria conversa cobrada em dobro
    expect(comTemplate).toHaveLength(1);
    expect(comTemplate[0]?.dedupeKey).toBe(`bot:cobranca:${c.id}:1`);

    const t = comTemplate[0]?.template as { nome: string; variaveis: string[]; botao?: unknown };
    expect(t.nome).toBe('cobranca_boleto');
    expect(t.botao).toBeUndefined(); // boleto não é pagável dentro do WhatsApp
    expect(t.variaveis).toHaveLength(4); // contrato do corpo aprovado
    expect(t.variaveis[2]).toBe(c.linhaDigitavel);
  }, 60_000);
});

/**
 * 044 — cobrança ativa pela carteira inadimplente.
 *
 * O que estes testes protegem, em ordem de gravidade: que o dry-run NÃO crie
 * nada (é o que separa olhar a carteira de cobrar gente de verdade), que a
 * supressão seja respeitada antes de qualquer cobrança nascer, e que a mesma
 * parcela não seja cobrada duas vezes.
 */
describe('spec 044 — campanha de cobrança pela carteira', () => {
  it('lista a carteira inadimplente com a parcela mais antiga de cada contrato', async () => {
    const r = await apiConsole('GET', '/api/console/cobranca/carteira');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    // o seed tem 10002 e 10003 inadimplentes na carteira; 10001 está em dia
    const porWa = new Map(body.linhas.map((l: { waId: string }) => [l.waId, l]));
    expect(porWa.has(WA_INADIMPLENTE)).toBe(true);
    expect(porWa.has(WA_EM_DIA)).toBe(false);

    const alvo = porWa.get(WA_INADIMPLENTE) as {
      qtdVencidas: number;
      parcela: number;
      parcelaValorCentavos: number;
      recusa: string | null;
    };
    expect(alvo.qtdVencidas).toBeGreaterThan(0);
    expect(alvo.parcelaValorCentavos).toBeGreaterThan(0);
    expect(alvo.recusa).toBeNull();
  }, 30_000);

  it('dry-run é o padrão: devolve o plano e NÃO cria cobrança nenhuma', async () => {
    const antes = await db.select().from(cobranca);
    const r = await apiConsole('POST', '/api/console/cobranca/campanha', {});
    expect(r.statusCode).toBe(200);
    expect(r.json().dryRun).toBe(true);
    expect(r.json().cobraveis).toBeGreaterThan(0);
    const depois = await db.select().from(cobranca);
    expect(depois).toHaveLength(antes.length);
  }, 30_000);

  it('confirmar: true cria a cobrança com origem campanha e recusa quem já tem uma', async () => {
    const r = await apiConsole('POST', '/api/console/cobranca/campanha', { confirmar: true });
    expect(r.statusCode).toBe(202);
    expect(r.json().dryRun).toBe(false);
    expect(r.json().cobrancasCriadas).toBeGreaterThan(0);

    const criadas = await db.select().from(cobranca).where(eq(cobranca.origem, 'campanha'));
    expect(criadas.length).toBeGreaterThan(0);
    const umaDelas = criadas[0];
    expect(umaDelas?.metodo).toBe('boleto');
    expect(umaDelas?.status).toBe('emitindo');

    // segunda chamada: a MESMA parcela não é cobrada de novo
    const r2 = await apiConsole('POST', '/api/console/cobranca/campanha', { confirmar: true });
    expect(r2.statusCode).toBe(202);
    expect(r2.json().cobrancasCriadas).toBe(0);
    expect(r2.json().recusados.map((x: { recusa: string }) => x.recusa)).toContain(
      'cobranca_em_aberto',
    );
  }, 60_000);

  it('quem pediu para sair não entra na campanha', async () => {
    await suprimir(db, WA_INADIMPLENTE, 'pedido_do_contato', 'pediu para sair');
    const r = await apiConsole('POST', '/api/console/cobranca/campanha', {});
    const linha = r.json().linhas.find((l: { waId: string }) => l.waId === WA_INADIMPLENTE) as {
      recusa: string;
    };
    expect(linha.recusa).toBe('suprimido');
  }, 30_000);
});
