import { join } from 'node:path';
import { loadClientConfig } from '@seta/client-config';
import { createLogger, newTraceId } from '@seta/observability';
import { JanelaFechadaError, type OutboundTemplate, signBody } from '@seta/wa-meta';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type App, buildApp } from '../src/app.ts';
import { FILA_DEBOUNCE, FILA_OUTBOX, startBoss } from '../src/boss.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  conversa,
  conversaLeitura,
  eventoTicket,
  mensagem,
  outbox,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
} from '../src/db/schema.ts';
import { type Env, loadEnv } from '../src/env.ts';
import { registerDebounceWorker, type TurnoPronto } from '../src/wa/debounce.ts';
import { estadoDigitando } from '../src/wa/dev-routes.ts';
import {
  enqueueOutbound,
  enviarLinha,
  registerOutboxWorker,
  varrerPendentesOrfas,
} from '../src/wa/outbox.ts';

/**
 * Critérios da spec 004 (integração; exige Postgres dev):
 * reentrega idempotente, 3 msgs → 1 turno, assinatura inválida sem side effects.
 */

const DEBOUNCE_MS = 500;
const logger = createLogger({ name: 'teste-wa', level: 'silent' });

let env: Env;
let db: Db;
let closeDb: () => Promise<void>;
let boss: Awaited<ReturnType<typeof startBoss>>;
/** 043: templates que o outbox worker mandou ao cair no ramo de janela fechada. */
const templatesEnviados: OutboundTemplate[] = [];
/** waIds que este arquivo cria — a limpeza do afterAll é restrita a eles. */
const WA_IDS_DO_ARQUIVO = [
  '5511999990001',
  '5511999990002',
  '5511999990003',
  '5511999990004',
  '5511999990005',
  '5511999990006',
  '5511999990007',
  '5511999990008',
  '5511999990009',
] as const;
let app: App;
const turnosProcessados: TurnoPronto[] = [];

async function aguardar(cond: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condição não atingida no tempo');
}

function payloadTexto(waId: string, waMessageId: string, texto: string, tsSegundos?: number) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: waId,
                  id: waMessageId,
                  timestamp: String(tsSegundos ?? Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: texto },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function postWebhook(corpo: string, assinatura?: string) {
  return app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      ...(assinatura ? { 'x-hub-signature-256': assinatura } : {}),
    },
    body: corpo,
  });
}

beforeAll(async () => {
  env = {
    ...loadEnv({
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://app_owner:app_owner_dev@localhost:5432/app',
      ERP_DATABASE_URL:
        process.env.ERP_DATABASE_URL ?? 'postgres://erp_ro:erp_ro_dev@localhost:5432/erp_mock',
      LOG_LEVEL: 'silent',
      DEV_SIMULATOR: 'true',
    } as NodeJS.ProcessEnv),
    WA_DEBOUNCE_MS: DEBOUNCE_MS,
  };
  const criado = createDb(env.DATABASE_URL);
  db = criado.db;
  closeDb = criado.close;
  try {
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  } catch (err) {
    throw new Error(
      'Postgres dev indisponível — suba com: docker compose -f infra/compose.dev.yml up -d --wait',
      { cause: err },
    );
  }
  boss = await startBoss(env.DATABASE_URL, logger);
  await registerDebounceWorker({
    db,
    boss,
    debounceMs: DEBOUNCE_MS,
    handler: {
      async processar(t) {
        turnosProcessados.push(t);
      },
    },
    logger,
  });
  const clientConfig = loadClientConfig(
    join(import.meta.dirname, '../../../configs/demo/client.yaml'),
  );
  app = buildApp({ env, clientConfig, wa: { db, boss } });
}, 30_000);

beforeEach(async () => {
  await boss.deleteQueuedJobs(FILA_DEBOUNCE);
  await boss.deleteQueuedJobs(FILA_OUTBOX);
  // turno em voo do teste anterior pode gravar trace no meio da limpeza (FK);
  // com as filas já limpas, repetir a limpeza resolve na 2ª tentativa
  for (let tentativa = 0; ; tentativa++) {
    try {
      await db.delete(sinalAprendizado);
      await db.delete(eventoTicket);
      await db.delete(ticket);
      await db.delete(traceTurno); // referencia turno (FK) — limpar primeiro
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
  // a suíte é serial e compartilha o banco: a conversa do ÚLTIMO teste deste
  // arquivo ficaria no topo de `GET /api/console/conversas` e quebraria a
  // contagem de não-lidas de console-atendimento (o mesmo tropeço da 042).
  // Só o que este arquivo criou — limpeza ampla aqui derruba outras suítes.
  for (const waId of WA_IDS_DO_ARQUIVO) {
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
    if (!conv) continue;
    await db
      .delete(eventoTicket)
      .where(eq(eventoTicket.ticketId, conv.id))
      .catch(() => {});
    await db.delete(ticket).where(eq(ticket.conversaId, conv.id));
    await db.delete(outbox).where(eq(outbox.conversaId, conv.id));
    await db.delete(mensagem).where(eq(mensagem.conversaId, conv.id));
    await db.delete(turno).where(eq(turno.conversaId, conv.id));
    await db.delete(conversa).where(eq(conversa.id, conv.id));
  }
  await app?.close();
  await boss?.stop({ graceful: false });
  await closeDb?.();
});

describe('critérios spec 004', () => {
  it('assinatura inválida → 401 sem side effects', async () => {
    const corpo = payloadTexto('5511999990001', 'wamid.assinatura', 'oi');
    const semAssinatura = await postWebhook(corpo);
    const assinaturaErrada = await postWebhook(corpo, signBody(corpo, 'outro-secret'));
    expect(semAssinatura.statusCode).toBe(401);
    expect(assinaturaErrada.statusCode).toBe(401);
    expect((await db.select({ n: count() }).from(mensagem))[0]?.n).toBe(0);
    expect((await db.select({ n: count() }).from(conversa))[0]?.n).toBe(0);
  });

  it('mensagem antiga fora de ordem não REGRIDE a janela de 24h (fix do review)', async () => {
    const waId = '5511999990009';
    const agora = Math.floor(Date.now() / 1000);
    const c1 = payloadTexto(waId, 'wamid.janela-nova', 'oi', agora);
    expect((await postWebhook(c1, signBody(c1, env.WA_APP_SECRET))).statusCode).toBe(200);
    const [antes] = await db.select().from(conversa).where(eq(conversa.waId, waId));
    const janelaAntes = antes?.janelaExpiraEm?.getTime() ?? 0;
    expect(janelaAntes).toBeGreaterThan(Date.now());

    // entrega atrasada: mensagem de 3h atrás chega DEPOIS da mais nova
    const c2 = payloadTexto(waId, 'wamid.janela-velha', 'mensagem atrasada', agora - 3 * 3600);
    expect((await postWebhook(c2, signBody(c2, env.WA_APP_SECRET))).statusCode).toBe(200);
    const [depois] = await db.select().from(conversa).where(eq(conversa.waId, waId));
    expect(depois?.janelaExpiraEm?.getTime()).toBe(janelaAntes); // GREATEST: não regrediu
  });

  it('reentrega do mesmo wa_message_id não duplica mensagem nem turno', async () => {
    const corpo = payloadTexto('5511999990002', 'wamid.reentrega', 'cadê meu pedido?');
    const assinatura = signBody(corpo, env.WA_APP_SECRET);
    expect((await postWebhook(corpo, assinatura)).statusCode).toBe(200);
    expect((await postWebhook(corpo, assinatura)).statusCode).toBe(200); // reentrega imediata

    await aguardar(async () => (await db.select({ n: count() }).from(turno))[0]?.n === 1);

    // reentrega DEPOIS do turno fechado também não cria nada
    expect((await postWebhook(corpo, assinatura)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2 + 300));

    expect((await db.select({ n: count() }).from(mensagem))[0]?.n).toBe(1);
    expect((await db.select({ n: count() }).from(turno))[0]?.n).toBe(1);
  });

  it('3 mensagens em rajada viram 1 turno agregado na ordem', async () => {
    const waId = '5511999990003';
    for (const [i, texto] of [
      'bom dia',
      'quais boletos tenho em aberto?',
      'do mês passado',
    ].entries()) {
      const corpo = payloadTexto(waId, `wamid.rajada-${i}`, texto);
      expect((await postWebhook(corpo, signBody(corpo, env.WA_APP_SECRET))).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 120)); // 3 msgs dentro da janela de silêncio
    }

    await aguardar(async () => (await db.select({ n: count() }).from(turno))[0]?.n >= 1);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300)); // garantiria 2º turno, se houvesse

    const turnos = await db.select().from(turno);
    expect(turnos).toHaveLength(1);
    expect(turnos[0]?.textoAgregado).toBe(
      'bom dia\nquais boletos tenho em aberto?\ndo mês passado',
    );
    const processado = turnosProcessados.find((t) => t.id === turnos[0]?.id);
    expect(processado).toBeDefined();
    // o indicador de digitação reage à ÚLTIMA mensagem da rajada: é o id dela que
    // a Meta aceita, e marcar a primeira como lida apontaria para a mensagem errada
    expect(processado?.waMessageIdUltima).toBe('wamid.rajada-2');
  });
});

describe('outbox', () => {
  it('dedupe por turnoId+seq, envio marca enviada e registra mensagem out', async () => {
    // conversa com janela aberta + turno
    const corpo = payloadTexto('5511999990004', 'wamid.outbox', 'oi');
    await postWebhook(corpo, signBody(corpo, env.WA_APP_SECRET));
    await aguardar(async () => (await db.select({ n: count() }).from(turno))[0]?.n === 1);
    const [t] = await db.select().from(turno);
    const [conv] = await db.select().from(conversa);
    if (!t || !conv) throw new Error('setup incompleto');

    const enviados: string[] = [];
    await registerOutboxWorker({
      db,
      boss,
      logger,
      gateway: {
        async send(msg, janela) {
          if (!janela.expiraEm || janela.expiraEm.getTime() < Date.now()) {
            throw new JanelaFechadaError(msg.to);
          }
          enviados.push(msg.body);
          return { waMessageId: `wamid.out-${enviados.length}` };
        },
        // 043: o worker passa a ter alternativa quando a janela fecha
        async sendTemplate(msg) {
          templatesEnviados.push(msg);
          return { waMessageId: `wamid.tpl-${templatesEnviados.length}` };
        },
      },
    });

    const item = { conversaId: conv.id, turnoId: t.id, seq: 1, texto: 'Segue seu boleto.' };
    expect((await enqueueOutbound({ db, boss }, item)).duplicada).toBe(false);
    expect((await enqueueOutbound({ db, boss }, item)).duplicada).toBe(true); // dedupe

    await aguardar(async () => {
      const [linha] = await db
        .select()
        .from(outbox)
        .where(eq(outbox.dedupeKey, `${t.id}:1`));
      return linha?.status === 'enviada';
    });
    expect(enviados).toEqual(['Segue seu boleto.']);
    const saidas = await db.select().from(mensagem).where(eq(mensagem.direcao, 'out'));
    expect(saidas).toHaveLength(1);
    expect(saidas[0]?.waMessageId).toBe('wamid.out-1');

    // webhook de status atualiza a mensagem out
    const statusCorpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.out-1', status: 'delivered' }] } }] }],
    });
    await postWebhook(statusCorpo, signBody(statusCorpo, env.WA_APP_SECRET));
    const [atualizada] = await db
      .select()
      .from(mensagem)
      .where(eq(mensagem.waMessageId, 'wamid.out-1'));
    expect(atualizada?.status).toBe('entregue');
  }, 20_000);

  it('janela fechada: marca janela_fechada sem lançar (POC sem template)', async () => {
    const [conv] = await db
      .insert(conversa)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8057',
        waId: '5511999990005',
        janelaExpiraEm: new Date(Date.now() - 1_000),
      })
      .returning();
    const [t] = await db
      .insert(turno)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8058',
        conversaId: conv?.id ?? '',
        textoAgregado: 'x',
      })
      .returning();
    if (!conv || !t) throw new Error('setup incompleto');

    await enqueueOutbound(
      { db, boss },
      { conversaId: conv.id, turnoId: t.id, seq: 1, texto: 'oi' },
    );
    await aguardar(async () => {
      const [linha] = await db
        .select()
        .from(outbox)
        .where(eq(outbox.dedupeKey, `${t.id}:1`));
      return linha?.status === 'janela_fechada';
    });
    // #29 (e spec 004): a janela fechada também MARCA o ticket p/ um humano.
    // Filtrado pela conversa DESTE teste: a tabela é compartilhada com os outros
    // arquivos da suíte, e ler `from(ticket)` inteiro faz o resultado depender
    // de quem rodou em paralelo — foi exatamente assim que este teste quebrou.
    const meusTickets = () => db.select().from(ticket).where(eq(ticket.conversaId, conv.id));
    await aguardar(async () => (await meusTickets()).length === 1);
    const [tk] = await meusTickets();
    expect(tk?.status).toBe('aguardando_humano');
    expect(tk?.motivoEscalonamento).toContain('janela');
  }, 15_000);

  it('043: janela fechada COM template na linha ⇒ reengaja sozinho, sem ticket', async () => {
    const [conv] = await db
      .insert(conversa)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8059',
        waId: '5511999990006',
        janelaExpiraEm: new Date(Date.now() - 1_000),
      })
      .returning();
    if (!conv) throw new Error('setup incompleto');

    await enqueueOutbound(
      { db, boss },
      {
        conversaId: conv.id,
        chave: 'cobranca:teste-043:1',
        texto: 'Sua cobrança de R$ 1.141,00 está pronta.',
        autor: 'bot',
        template: {
          nome: 'modelo_msg_pagamento_',
          idioma: 'pt_BR',
          variaveis: ['https://sandbox.asaas.com/i/abc'],
          botao: {
            tipo: 'order_details',
            indice: 0,
            orderDetails: {
              referenceId: 'cob-1',
              tipo: 'digital-goods',
              totalCentavos: 114_100,
              taxaCentavos: 0,
              itens: [
                { retailerId: '138', nome: 'Parcela 7/100', valorCentavos: 114_100, quantidade: 1 },
              ],
              pix: {
                code: '00020101021226820014br.gov.bcb.pix',
                merchantName: 'SETA TECH LTDA',
                key: 'chave-pix',
                keyType: 'EVP',
              },
            },
          },
        },
      },
    );

    await aguardar(async () => {
      const [linha] = await db
        .select()
        .from(outbox)
        .where(eq(outbox.dedupeKey, 'bot:cobranca:teste-043:1'));
      return linha?.status === 'enviada';
    });
    expect(templatesEnviados).toHaveLength(1);
    expect(templatesEnviados[0]).toMatchObject({
      to: '5511999990006',
      nome: 'modelo_msg_pagamento_',
    });
    expect(templatesEnviados[0]?.botao?.orderDetails.totalCentavos).toBe(114_100);
    // a thread mostra o texto que o cotista viu, e NENHUM ticket é aberto
    const msgs = await db.select().from(mensagem).where(eq(mensagem.conversaId, conv.id));
    expect(msgs.some((m) => m.texto.includes('R$ 1.141,00'))).toBe(true);
    expect(await db.select().from(ticket).where(eq(ticket.conversaId, conv.id))).toHaveLength(0);
  }, 15_000);

  it('janela ABERTA com template na linha ⇒ sai o card, não o texto', async () => {
    /**
     * Decisão do Renato em 24/09, depois do card não aparecer no teste de
     * campo: o template é o que sai, não o plano B do reengajamento. Com a
     * janela aberta — que é sempre o caso na demo, porque o cliente acabou de
     * escrever — o cotista recebia texto puro, sem o botão de copiar o código;
     * o único elemento tocável da conversa acabava sendo o domínio que mora
     * dentro do BR Code do PIX, que não abre nada.
     */
    const [conv] = await db
      .insert(conversa)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8060',
        waId: '5511999990007',
        janelaExpiraEm: new Date(Date.now() + 3_600_000),
      })
      .returning();
    if (!conv) throw new Error('setup incompleto');
    const antes = templatesEnviados.length;

    await enqueueOutbound(
      { db, boss },
      {
        conversaId: conv.id,
        chave: 'cobranca:teste-janela-aberta:1',
        texto: 'Seu PIX de R$ 2.000,00 está pronto.',
        autor: 'bot',
        template: {
          nome: 'cobranca_pix',
          idioma: 'pt_BR',
          variaveis: ['R$ 2.000,00', '27/09/2026', 'https://sandbox.asaas.com/i/xyz'],
          botao: {
            tipo: 'order_details',
            indice: 0,
            orderDetails: {
              referenceId: 'cob-2',
              tipo: 'digital-goods',
              totalCentavos: 200_000,
              taxaCentavos: 0,
              itens: [{ retailerId: '1', nome: 'Sinal', valorCentavos: 200_000, quantidade: 1 }],
              pix: {
                code: '00020101021226820014br.gov.bcb.pix',
                merchantName: 'SETA TECH LTDA',
                key: 'chave-pix',
                keyType: 'EVP',
              },
            },
          },
        },
      },
    );

    await aguardar(async () => {
      const [linha] = await db
        .select()
        .from(outbox)
        .where(eq(outbox.dedupeKey, 'bot:cobranca:teste-janela-aberta:1'));
      return linha?.status === 'enviada';
    });
    expect(templatesEnviados).toHaveLength(antes + 1);
    expect(templatesEnviados.at(-1)).toMatchObject({ to: '5511999990007', nome: 'cobranca_pix' });
    // a thread guarda o texto legível, que é o que o console e o histórico leem
    const msgs = await db.select().from(mensagem).where(eq(mensagem.conversaId, conv.id));
    expect(msgs.some((m) => m.texto.includes('R$ 2.000,00'))).toBe(true);
  }, 15_000);

  it('#29: retries esgotados → linha vira `falha` e o ticket escala (dead-letter)', async () => {
    const [conv] = await db
      .insert(conversa)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8060',
        waId: '5511999990007',
        janelaExpiraEm: new Date(Date.now() + 3600_000),
      })
      .returning();
    const [t] = await db
      .insert(turno)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8061',
        conversaId: conv?.id ?? '',
        textoAgregado: 'x',
      })
      .returning();
    if (!conv || !t) throw new Error('setup incompleto');
    const r = await enqueueOutbound(
      { db, boss },
      { conversaId: conv.id, turnoId: t.id, seq: 1, texto: 'não vai sair' },
    );

    const gatewayQuebrado = {
      async send(): Promise<{ waMessageId: string }> {
        throw new Error('Meta fora do ar');
      },
    };
    // última tentativa (retryCount == limite): não relança, marca falha + ticket
    await enviarLinha({ db, boss, logger, gateway: gatewayQuebrado }, r.outboxId ?? '', true);

    const [linha] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, r.outboxId ?? ''));
    expect(linha?.status).toBe('falha');
    const [tk] = await db.select().from(ticket).where(eq(ticket.conversaId, conv.id));
    expect(tk?.status).toBe('aguardando_humano');
    expect(tk?.motivoEscalonamento).toContain('falha ao enviar');
  }, 15_000);

  it('#29: pendente órfã (crash entre insert e send) é ressuscitada pelo sweeper', async () => {
    const [conv] = await db
      .insert(conversa)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8062',
        waId: '5511999990008',
        janelaExpiraEm: new Date(Date.now() + 3600_000),
      })
      .returning();
    if (!conv) throw new Error('setup incompleto');
    // linha pendente ANTIGA sem job (simula o crash pós-insert)
    const [linha] = await db
      .insert(outbox)
      .values({
        id: '01990a5d-ac96-774b-bcce-b302099a8063',
        conversaId: conv.id,
        turnoId: null,
        seq: 1,
        dedupeKey: 'manual:orfa-teste',
        autor: 'atendente',
        texto: 'mensagem órfã',
        atualizadoEm: new Date(Date.now() - 11 * 60 * 1000),
      })
      .returning();
    if (!linha) throw new Error('setup incompleto');

    const gatewayOk = {
      async send(): Promise<{ waMessageId: string }> {
        return { waMessageId: 'wamid.orfa-1' };
      },
    };
    const n = await varrerPendentesOrfas({ db, boss, logger, gateway: gatewayOk });
    expect(n).toBe(1);
    // o worker registrado na suíte pega o job re-enfileirado e envia
    await aguardar(async () => {
      const [l] = await db.select().from(outbox).where(eq(outbox.id, linha.id));
      return l?.status === 'enviada';
    }, 12_000);
  }, 20_000);
});

describe('simulador dev', () => {
  it('POST /dev/inbound entra pelo mesmo caminho (conversa + mensagem + debounce)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dev/inbound',
      payload: { waId: '5511999990006', text: 'oi pelo simulador' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().duplicada).toBe(false);
    await aguardar(async () => (await db.select({ n: count() }).from(turno))[0]?.n === 1);
  });
});

/**
 * A bolha "digitando…" do simulador. A decisão pura tem teste próprio
 * (`digitando-simulador.test.ts`); aqui o que se prova é o SQL — nomes de coluna,
 * o filtro por `turnoId` + `direcao` e a ordenação — contra o banco de verdade.
 * O SSE em si não cabe num `app.inject`: é stream que nunca termina.
 */
describe('estado de digitação do simulador', () => {
  const TETO = 60_000;

  it('turno recém-criado: digitando; a mensagem de saída apaga', async () => {
    const waId = '5511999990010';
    const corpo = payloadTexto(waId, 'wamid.digitando-1', 'oi');
    expect((await postWebhook(corpo, signBody(corpo, env.WA_APP_SECRET))).statusCode).toBe(200);
    await aguardar(async () => {
      const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
      if (!conv) return false;
      const turnos = await db.select().from(turno).where(eq(turno.conversaId, conv.id));
      return turnos.length === 1;
    });
    const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
    if (!conv) throw new Error('sem conversa');
    const [t] = await db.select().from(turno).where(eq(turno.conversaId, conv.id));
    if (!t) throw new Error('sem turno');

    expect(await estadoDigitando(db, conv.id, TETO)).toBe(true);

    // é o worker do outbox que grava a mensagem `out` no instante do envio —
    // o mesmo instante em que o WhatsApp apaga o indicador
    await db.insert(mensagem).values({
      id: newTraceId(),
      conversaId: conv.id,
      direcao: 'out',
      autor: 'bot',
      texto: 'Olá! Como posso ajudar?',
      status: 'enviada',
      turnoId: t.id,
    });

    expect(await estadoDigitando(db, conv.id, TETO)).toBe(false);
  });

  it('conversa sem turno nenhum não está digitando', async () => {
    const conversaId = newTraceId();
    await db.insert(conversa).values({ id: conversaId, waId: '5511999990011' });

    expect(await estadoDigitando(db, conversaId, TETO)).toBe(false);
  });
});
