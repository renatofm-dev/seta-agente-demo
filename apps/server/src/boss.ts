import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

export const FILA_DEBOUNCE = 'turno-debounce';
export const FILA_OUTBOX = 'outbox-send';
export const FILA_OUTBOX_SWEEP = 'outbox-sweep';
/** 013: envio de disparos de template para a carteira. */
export const FILA_DISPARO = 'disparo-send';
/** Mesmo retryLimit da fila — a última tentativa vira dead-letter (#29). */
export const OUTBOX_RETRY_LIMIT = 5;

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
  return boss;
}
