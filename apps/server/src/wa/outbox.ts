import { newTraceId } from '@seta/observability';
import {
  JanelaFechadaError,
  type OutboundGateway,
  type OutboundTemplate,
  OutboundTemplateSchema,
} from '@seta/wa-meta';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_OUTBOX, FILA_OUTBOX_SWEEP, OUTBOX_RETRY_LIMIT } from '../boss.js';
import type { Db } from '../db/index.js';
import { conversa, mensagem, outbox } from '../db/schema.js';
import { aplicarTransicao, garantirTicket } from './tickets.js';

/**
 * Outbox: toda resposta vira linha com dedupe (turnoId+seq) antes de qualquer
 * side effect externo; o worker envia via gateway com retry exponencial do
 * pg-boss e registra a mensagem `out` para os webhooks de status atualizarem.
 */

export interface OutboxDeps {
  readonly db: Db;
  readonly boss: PgBoss;
}

export type OutboundItem =
  | {
      /** Resposta do bot: dedupe por turno+seq. */
      readonly conversaId: string;
      readonly turnoId: string;
      readonly seq: number;
      readonly texto: string;
      readonly autor?: 'bot';
    }
  | {
      /** Resposta manual do atendente (007): sem turno; dedupe por chave do cliente. */
      readonly conversaId: string;
      readonly turnoId?: undefined;
      readonly chave: string;
      readonly texto: string;
      readonly autor: 'atendente';
      /** #45: user.id de quem respondeu — propaga à mensagem para a thread. */
      readonly atendenteId: string;
    }
  | {
      /**
       * 014: mensagem do bot FORA de um turno (worker de emissão, confirmação de
       * pagamento pelo webhook): dedupe por chave (`cobranca:{id}:{seq}`).
       */
      readonly conversaId: string;
      readonly turnoId?: undefined;
      readonly chave: string;
      readonly texto: string;
      readonly autor: 'bot';
      /**
       * 043: template equivalente a este texto, usado se a janela fechar antes
       * do envio. Sem ele, janela fechada continua virando ticket (014).
       */
      readonly template?: TemplateDaLinha;
    };

/**
 * Só o INSERT do outbox (aceita tx — #46: o turno-handler insere na mesma
 * transação da checagem de pendentes). O job do worker é enviado à parte,
 * DEPOIS do commit, via enviarJobOutbound.
 */
/**
 * 043: o que a linha carrega para reenviar como template. É `Omit<...,'to'>`
 * porque o destinatário sai da conversa no instante do envio, não da gravação.
 */
export type TemplateDaLinha = Omit<OutboundTemplate, 'to'>;

/** JSONB é fronteira de entrada: valida na leitura, nunca confia na coluna. */
const TemplateDaLinhaSchema = OutboundTemplateSchema.omit({ to: true });

export async function inserirOutbound(
  db: Pick<Db, 'insert'>,
  item: OutboundItem,
): Promise<{ duplicada: boolean; outboxId?: string }> {
  const semTurno = item.turnoId === undefined;
  const dedupeKey = semTurno
    ? `${item.autor === 'atendente' ? 'manual' : 'bot'}:${item.chave}`
    : `${item.turnoId}:${item.seq}`;
  const [linha] = await db
    .insert(outbox)
    .values({
      id: newTraceId(),
      conversaId: item.conversaId,
      turnoId: semTurno ? null : item.turnoId,
      seq: semTurno ? 1 : item.seq,
      dedupeKey,
      autor: item.autor ?? 'bot',
      atendenteId: semTurno && item.autor === 'atendente' ? item.atendenteId : null,
      texto: item.texto,
      template: semTurno && item.autor !== 'atendente' ? (item.template ?? null) : null,
    })
    .onConflictDoNothing({ target: outbox.dedupeKey })
    .returning();
  if (!linha) return { duplicada: true };
  return { duplicada: false, outboxId: linha.id };
}

export async function enviarJobOutbound(boss: PgBoss, outboxId: string): Promise<void> {
  await boss.send(FILA_OUTBOX, { outboxId });
}

export async function enqueueOutbound(
  deps: OutboxDeps,
  item: OutboundItem,
): Promise<{ duplicada: boolean; outboxId?: string }> {
  const r = await inserirOutbound(deps.db, item);
  if (!r.duplicada && r.outboxId) await enviarJobOutbound(deps.boss, r.outboxId);
  return r;
}

export interface OutboxWorkerDeps extends OutboxDeps {
  readonly gateway: OutboundGateway;
  readonly logger: Logger;
}

export async function registerOutboxWorker(deps: OutboxWorkerDeps): Promise<void> {
  await deps.boss.work<{ outboxId: string }>(
    FILA_OUTBOX,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        const retryCount = (job as unknown as { retryCount?: number }).retryCount ?? 0;
        await enviarLinha(deps, job.data.outboxId, retryCount >= OUTBOX_RETRY_LIMIT);
      }
    },
  );
}

/** #29: entrega indeliverável marca o ticket — humano fica sabendo na hora. */
async function marcarTicketPorFalha(
  deps: OutboxWorkerDeps,
  conversaId: string,
  motivo: string,
): Promise<void> {
  try {
    const t = await garantirTicket(deps.db, conversaId);
    if (t.status === 'bot_ativo') {
      await aplicarTransicao(deps.db, t, 'aguardando_humano', 'bot', { motivo });
    }
  } catch (err) {
    deps.logger.error({ err, conversaId }, 'falha ao marcar ticket após erro de envio');
  }
}

export async function enviarLinha(
  deps: OutboxWorkerDeps,
  outboxId: string,
  ultimaTentativa = false,
): Promise<void> {
  const [linha] = await deps.db.select().from(outbox).where(eq(outbox.id, outboxId));
  if (linha?.status !== 'pendente') return; // inexistente ou já resolvida (dedupe/reprocesso)
  const [conv] = await deps.db.select().from(conversa).where(eq(conversa.id, linha.conversaId));
  if (!conv) throw new Error(`outbox ${outboxId} sem conversa`);

  try {
    const { waMessageId } = await deps.gateway.send(
      { to: conv.waId, body: linha.texto },
      { expiraEm: conv.janelaExpiraEm },
    );
    await deps.db.transaction(async (tx) => {
      await tx
        .update(outbox)
        .set({
          status: 'enviada',
          waMessageId,
          tentativas: sql`${outbox.tentativas} + 1`,
          atualizadoEm: new Date(),
        })
        .where(eq(outbox.id, outboxId));
      await tx.insert(mensagem).values({
        id: newTraceId(),
        conversaId: conv.id,
        direcao: 'out',
        autor: linha.autor,
        atendenteId: linha.atendenteId,
        waMessageId,
        texto: linha.texto,
        status: 'enviada',
        turnoId: linha.turnoId,
      });
    });
  } catch (err) {
    if (err instanceof JanelaFechadaError) {
      // Envio LIVRE fora da janela de 24h não existe na Meta (só template aprovado — 013 usa
      // nos disparos e no aviso de pagamento).
      // 043: se ESTA linha trouxe um template equivalente, o reengajamento é
      // automático — é o único instante em que dá para decidir texto × template,
      // porque a janela pode ter fechado depois do INSERT.
      const template = TemplateDaLinhaSchema.safeParse(linha.template);
      if (template.success) {
        const { waMessageId } = await deps.gateway.sendTemplate({
          ...template.data,
          to: conv.waId,
        });
        await deps.db.transaction(async (tx) => {
          await tx
            .update(outbox)
            .set({ status: 'enviada', waMessageId, atualizadoEm: new Date() })
            .where(eq(outbox.id, outboxId));
          await tx.insert(mensagem).values({
            id: newTraceId(),
            conversaId: conv.id,
            direcao: 'out',
            autor: linha.autor,
            waMessageId,
            texto: linha.texto,
            status: 'enviada',
            turnoId: linha.turnoId,
          });
        });
        deps.logger.info(
          { outboxId, waId: conv.waId, template: template.data.nome },
          'janela fechada — reengajado por template',
        );
        return;
      }
      // sem template: comportamento da 014 — marca a linha E o ticket.
      await deps.db
        .update(outbox)
        .set({ status: 'janela_fechada', atualizadoEm: new Date() })
        .where(eq(outbox.id, outboxId));
      await marcarTicketPorFalha(deps, conv.id, 'janela de 24h fechada — reengajar por template');
      deps.logger.warn({ outboxId, waId: conv.waId }, 'janela de 24h fechada — envio abortado');
      return;
    }
    await deps.db
      .update(outbox)
      .set({ tentativas: sql`${outbox.tentativas} + 1`, atualizadoEm: new Date() })
      .where(eq(outbox.id, outboxId));
    if (ultimaTentativa) {
      // #29: dead-letter — a mensagem NÃO some em silêncio: linha vira `falha`
      // e o ticket escala para um humano reenviar/decidir
      await deps.db
        .update(outbox)
        .set({ status: 'falha', atualizadoEm: new Date() })
        .where(eq(outbox.id, outboxId));
      await marcarTicketPorFalha(deps, conv.id, 'falha ao enviar resposta ao contato');
      deps.logger.error({ err, outboxId }, 'outbox: retries esgotados — linha em falha');
      return;
    }
    throw err; // pg-boss re-tenta com backoff exponencial (config da fila)
  }
}

/**
 * #29: varredura de órfãs — crash entre o INSERT do outbox e o boss.send deixa
 * linha `pendente` sem job. Recoloca na fila linhas pendentes velhas o bastante
 * para o ciclo de retries original já ter morrido (sem risco de envio duplo).
 */
export const ORFA_APOS_MS = 10 * 60 * 1000;

export async function varrerPendentesOrfas(deps: OutboxWorkerDeps): Promise<number> {
  const corte = new Date(Date.now() - ORFA_APOS_MS);
  const orfas = await deps.db
    .select({ id: outbox.id })
    .from(outbox)
    .where(sql`${outbox.status} = 'pendente' AND ${outbox.atualizadoEm} < ${corte}`);
  for (const linha of orfas) {
    await deps.boss.send(FILA_OUTBOX, { outboxId: linha.id }, { singletonKey: linha.id });
  }
  if (orfas.length > 0) {
    deps.logger.warn({ n: orfas.length }, 'outbox: pendentes órfãs re-enfileiradas');
  }
  return orfas.length;
}

export async function registerOutboxSweeper(deps: OutboxWorkerDeps): Promise<void> {
  await deps.boss.schedule(FILA_OUTBOX_SWEEP, '* * * * *');
  await deps.boss.work(FILA_OUTBOX_SWEEP, async () => {
    await varrerPendentesOrfas(deps);
  });
}
