import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

export const FILA_DEBOUNCE = 'turno-debounce';
export const FILA_OUTBOX = 'outbox-send';

/** pg-boss no banco `app` (schema pgboss próprio). Filas criadas no boot. */
export async function startBoss(url: string, logger: Logger): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => logger.error(err, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(FILA_DEBOUNCE);
  await boss.createQueue(FILA_OUTBOX, { retryLimit: 5, retryBackoff: true, retryDelay: 2 });
  return boss;
}
