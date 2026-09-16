import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

export const FILA_DEBOUNCE = 'turno-debounce';
export const FILA_OUTBOX = 'outbox-send';
export const FILA_OUTBOX_SWEEP = 'outbox-sweep';
/** 013: envio de disparos de template para a carteira. */
export const FILA_DISPARO = 'disparo-send';
/** 014: emissão da cobrança no PSP (retry com backoff; auth/negócio não re-tentam). */
export const FILA_COBRANCA_EMITIR = 'cobranca-emitir';
/** 014: processamento dos eventos do webhook do PSP (idempotente por evento). */
export const FILA_COBRANCA_EVENTO = 'cobranca-evento';
/** 036: baixa no ERP pela API do TSE (retry com backoff; auth/negócio vão para humano). */
export const FILA_ERP_BAIXA = 'erp-baixa';
/** 038: criação e confirmação da reserva no ERP (retry com backoff). */
export const FILA_ERP_RESERVA = 'erp-reserva';
/** Mesmo retryLimit da fila — a última tentativa vira dead-letter (#29). */
export const OUTBOX_RETRY_LIMIT = 5;
export const COBRANCA_RETRY_LIMIT = 5;

/** pg-boss no banco `app` (schema pgboss próprio). Filas criadas no boot. */
export async function startBoss(url: string, logger: Logger): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => logger.error(err, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(FILA_DEBOUNCE);
  await boss.createQueue(FILA_OUTBOX, {
    retryLimit: OUTBOX_RETRY_LIMIT,
    retryBackoff: true,
    retryDelay: 2,
  });
  await boss.createQueue(FILA_OUTBOX_SWEEP);
  await boss.createQueue(FILA_DISPARO);
  await boss.createQueue(FILA_COBRANCA_EMITIR, {
    retryLimit: COBRANCA_RETRY_LIMIT,
    retryBackoff: true,
    retryDelay: 2,
  });
  await boss.createQueue(FILA_COBRANCA_EVENTO, {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 2,
  });
  await boss.createQueue(FILA_ERP_BAIXA, {
    retryLimit: COBRANCA_RETRY_LIMIT,
    retryBackoff: true,
    retryDelay: 2,
  });
  await boss.createQueue(FILA_ERP_RESERVA, {
    retryLimit: COBRANCA_RETRY_LIMIT,
    retryBackoff: true,
    retryDelay: 2,
  });
  return boss;
}
