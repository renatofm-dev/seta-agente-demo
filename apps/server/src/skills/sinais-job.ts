import { newTraceId } from '@seta/observability';
import { and, sql as dsql, eq, gt, isNull, lt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { mensagem, sinalAprendizado, ticket } from '../db/schema.js';

/**
 * Job diário de coleta de sinais (009): `resolucao_limpa` (resolvido sem humano
 * e sem recontato em 48h) e `re_pergunta` (heurística simples de repetição).
 */

export const FILA_SINAIS_DIARIOS = 'sinais-diarios';
const JANELA_RECONTATO_MS = 48 * 3600 * 1000;
const JANELA_REPERGUNTA_MS = 15 * 60 * 1000;

async function jaTemSinal(db: Db, tipo: string, refId: string): Promise<boolean> {
  const r = await db.execute(dsql`
    SELECT 1 FROM sinal_aprendizado
    WHERE tipo = ${tipo} AND payload ->> 'refId' = ${refId} LIMIT 1
  `);
  return r.rows.length > 0;
}

export async function coletarSinaisDiarios(
  db: Db,
): Promise<{ resolucaoLimpa: number; rePergunta: number }> {
  let resolucaoLimpa = 0;
  let rePergunta = 0;

  // resolucao_limpa: ticket resolvido, sem atendente, sem mensagem nova em 48h
  const limite = new Date(Date.now() - JANELA_RECONTATO_MS);
  const resolvidos = await db
    .select()
    .from(ticket)
    .where(
      and(
        eq(ticket.status, 'resolvido'),
        isNull(ticket.atendenteId),
        lt(ticket.atualizadoEm, limite),
      ),
    );
  for (const t of resolvidos) {
    if (await jaTemSinal(db, 'resolucao_limpa', t.id)) continue;
    const [recontato] = await db
      .select({ id: mensagem.id })
      .from(mensagem)
      .where(
        and(
          eq(mensagem.conversaId, t.conversaId),
          eq(mensagem.direcao, 'in'),
          gt(mensagem.criadoEm, t.atualizadoEm),
        ),
      )
      .limit(1);
    if (recontato) continue;
    await db.insert(sinalAprendizado).values({
      id: newTraceId(),
      tipo: 'resolucao_limpa',
      ticketId: t.id,
      conversaId: t.conversaId,
      payload: { refId: t.id, resolvidoEm: t.atualizadoEm.toISOString() },
    });
    resolucaoLimpa += 1;
  }

  // re_pergunta: duas mensagens do contato muito parecidas em <15min com resposta do bot no meio
  const desde = new Date(Date.now() - 24 * 3600 * 1000);
  const recentes = await db
    .select()
    .from(mensagem)
    .where(gt(mensagem.criadoEm, desde))
    .orderBy(mensagem.conversaId, mensagem.criadoEm);
  for (let i = 2; i < recentes.length; i++) {
    const [a, meio, b] = [recentes[i - 2], recentes[i - 1], recentes[i]];
    if (!a || !meio || !b) continue;
    if (a.conversaId !== b.conversaId || meio.conversaId !== b.conversaId) continue;
    if (a.direcao !== 'in' || b.direcao !== 'in' || meio.autor !== 'bot') continue;
    if (b.criadoEm.getTime() - a.criadoEm.getTime() > JANELA_REPERGUNTA_MS) continue;
    if (similaridadeTokens(a.texto, b.texto) < 0.6) continue;
    if (await jaTemSinal(db, 're_pergunta', b.id)) continue;
    await db.insert(sinalAprendizado).values({
      id: newTraceId(),
      tipo: 're_pergunta',
      conversaId: b.conversaId,
      payload: { refId: b.id, pergunta: a.texto, rePergunta: b.texto, respostaBot: meio.texto },
    });
    rePergunta += 1;
  }

  return { resolucaoLimpa, rePergunta };
}

function similaridadeTokens(a: string, b: string): number {
  const t = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((x) => x.length > 2),
    );
  const ta = t(a);
  const tb = t(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let comum = 0;
  for (const x of ta) if (tb.has(x)) comum += 1;
  return comum / Math.max(ta.size, tb.size);
}

export async function registerSinaisDiarios(boss: PgBoss, db: Db, logger: Logger): Promise<void> {
  await boss.createQueue(FILA_SINAIS_DIARIOS);
  await boss.schedule(FILA_SINAIS_DIARIOS, '0 3 * * *', {}, {});
  await boss.work(FILA_SINAIS_DIARIOS, async () => {
    const r = await coletarSinaisDiarios(db);
    logger.info(r, 'sinais diários coletados');
  });
}
