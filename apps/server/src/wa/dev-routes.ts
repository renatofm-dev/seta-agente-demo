import { newTraceId } from '@seta/observability';
import { WaPhoneSchema } from '@seta/wa-meta';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type Auth, sessaoDaRequest } from '../auth.js';
import type { Db } from '../db/index.js';
import { conversa, mensagem, turno } from '../db/schema.js';
import type { Env } from '../env.js';
import { processInbound } from './inbound.js';

/**
 * Simulador dev (DEV_SIMULATOR=true): injeta mensagens no MESMO caminho do
 * webhook (mesma idempotência, mesmo debounce) e transmite a conversa via SSE.
 * É o plano B da demo (000). Com `auth` presente (011: exposto na demo
 * pública), TODA rota /dev exige sessão do console — sem isso qualquer um com
 * a URL injeta mensagens como qualquer waId e lê conversas alheias.
 */

export interface DevRoutesOpts {
  readonly env: Env;
  readonly db: Db;
  readonly boss: PgBoss;
  /** Presente ⇒ /dev/* exige sessão Better Auth (atendente|curador). */
  readonly auth?: Auth;
}

const InboundBodySchema = z.object({
  waId: WaPhoneSchema,
  text: z.string().min(1).max(4096),
});

const SSE_INTERVALO_MS = 700;

/**
 * "Digitando…" no simulador.
 *
 * O simulador não enxerga a chamada à Graph API (em dev ela não acontece): ele
 * REPRODUZ o estado que liga o indicador no WhatsApp — turno aberto, resposta
 * ainda não enviada. Mesma fonte de verdade, canais diferentes.
 *
 * Não dá para derivar isso no cliente: dentro de um mesmo tique o loop varre
 * `mensagem` ANTES de `turno`, então num turno rápido os eventos chegariam na
 * ordem [mensagem out, turno] e a regra "último evento é turno" travaria a bolha.
 *
 * O teto é o do turno (`AGENT_TURN_TIMEOUT_MS`): turno que nunca respondeu —
 * fusão descartada (#46) ou atendente que assumiu (#47) — apaga a bolha, em vez
 * de deixá-la girando para sempre.
 */
export function digitandoAgora(
  turnoAberto: { readonly criadoEm: Date } | null,
  jaRespondeu: boolean,
  agora: Date,
  tetoMs: number,
): boolean {
  if (!turnoAberto || jaRespondeu) return false;
  return agora.getTime() - turnoAberto.criadoEm.getTime() < tetoMs;
}

/**
 * O estado lido do banco: o turno mais RECENTE da conversa (o anterior, já
 * respondido ou descartado, não tem mais ninguém digitando por ele) e se ele já
 * produziu mensagem de saída. A resposta do bot entra em `mensagem` com
 * `direcao: 'out'` e o `turnoId` do turno — é o worker do outbox que grava, no
 * instante do envio, que é exatamente quando o WhatsApp apaga o indicador.
 *
 * Separado de `digitandoAgora` para a decisão ser testável sem banco e o SQL ser
 * testável sem SSE (que, sendo stream infinito, não cabe num `app.inject`).
 */
export async function estadoDigitando(
  db: Db,
  conversaId: string,
  tetoMs: number,
): Promise<boolean> {
  const [ultimo] = await db
    .select({ id: turno.id, criadoEm: turno.criadoEm })
    .from(turno)
    .where(eq(turno.conversaId, conversaId))
    .orderBy(desc(turno.criadoEm))
    .limit(1);
  if (!ultimo) return false;
  const resposta = await db
    .select({ id: mensagem.id })
    .from(mensagem)
    .where(and(eq(mensagem.turnoId, ultimo.id), eq(mensagem.direcao, 'out')))
    .limit(1);
  return digitandoAgora(ultimo, resposta.length > 0, new Date(), tetoMs);
}

export const devRoutes: FastifyPluginCallback<DevRoutesOpts> = (app, opts, done) => {
  const { env, db, boss, auth } = opts;

  if (auth) {
    app.addHook('preHandler', async (req, reply) => {
      const sessao = await sessaoDaRequest(auth, req.headers);
      if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    });
  }

  app.post('/dev/inbound', async (req, reply) => {
    const body = InboundBodySchema.parse(req.body);
    const resultado = await processInbound(
      { db, boss, debounceMs: env.WA_DEBOUNCE_MS },
      {
        waId: body.waId,
        waMessageId: `sim-${newTraceId()}`,
        texto: body.text,
        timestamp: new Date(),
      },
    );
    return reply.code(202).send(resultado);
  });

  app.get('/dev/events', async (req, reply) => {
    const { waId } = z.object({ waId: WaPhoneSchema }).parse(req.query);
    // sem CORS: o console consome via rewrite same-origin do Next
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': conectado\n\n');

    // cursor recuado 1s + dedupe por id: o timestamptz tem precisão de µs e o
    // Date JS trunca em ms — comparar só por `>` re-emitiria a última linha
    const vistos = new Set<string>();
    let cursorMsg = new Date(0);
    let cursorTurno = new Date(0);
    let digitando = false;
    const recuo = (d: Date) => new Date(d.getTime() - 1_000);
    const timer = setInterval(async () => {
      try {
        const [conv] = await db.select().from(conversa).where(eq(conversa.waId, waId));
        if (!conv) return;
        const novas = await db
          .select()
          .from(mensagem)
          .where(and(eq(mensagem.conversaId, conv.id), gt(mensagem.criadoEm, recuo(cursorMsg))))
          .orderBy(asc(mensagem.criadoEm));
        for (const m of novas) {
          cursorMsg = m.criadoEm;
          if (vistos.has(m.id)) continue;
          vistos.add(m.id);
          reply.raw.write(
            `event: mensagem\ndata: ${JSON.stringify({
              id: m.id,
              direcao: m.direcao,
              texto: m.texto,
              status: m.status,
              criadoEm: m.criadoEm,
            })}\n\n`,
          );
        }
        const turnos = await db
          .select()
          .from(turno)
          .where(and(eq(turno.conversaId, conv.id), gt(turno.criadoEm, recuo(cursorTurno))))
          .orderBy(asc(turno.criadoEm));
        for (const t of turnos) {
          cursorTurno = t.criadoEm;
          if (vistos.has(t.id)) continue;
          vistos.add(t.id);
          reply.raw.write(
            `event: turno\ndata: ${JSON.stringify({ id: t.id, textoAgregado: t.textoAgregado })}\n\n`,
          );
        }
        const ativo = await estadoDigitando(db, conv.id, env.AGENT_TURN_TIMEOUT_MS);
        // só na MUDANÇA: emitir a cada 700 ms encheria o stream de ruído
        if (ativo !== digitando) {
          digitando = ativo;
          reply.raw.write(`event: digitando\ndata: ${JSON.stringify({ ativo })}\n\n`);
        }
      } catch (err) {
        req.log.warn({ err }, 'sse: falha ao consultar conversa');
      }
    }, SSE_INTERVALO_MS);

    req.raw.on('close', () => clearInterval(timer));
  });

  done();
};
