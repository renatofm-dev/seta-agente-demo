import { newTraceId } from '@seta/observability';
import type { OutboundGateway } from '@seta/wa-meta';
import { and, asc, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_DISPARO } from '../boss.js';
import type { Db } from '../db/index.js';
import { conversa, disparo, disparoDestinatario, mensagem, modeloMensagem } from '../db/schema.js';
import { suprimidosEntre } from './supressao.js';

/**
 * Worker de disparo (013): envia o template para cada destinatário pendente,
 * grava a mensagem `campanha` na thread da conversa (criando a conversa quando
 * não existe — a resposta do cliente cai no fluxo normal de turno) e atualiza
 * o status por destinatário. Falha em um NÃO derruba os demais.
 */

export interface DisparoWorkerDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly gateway: OutboundGateway;
  readonly logger: Logger;
}

/** Substitui {{1}}..{{N}} pelos valores — o texto como o cliente vê na thread. */
export function renderizarCorpo(corpo: string, variaveis: readonly string[]): string {
  return corpo.replaceAll(/\{\{(\d+)\}\}/g, (m, n: string) => variaveis[Number(n) - 1] ?? m);
}

export async function registerDisparoWorker(deps: DisparoWorkerDeps): Promise<void> {
  await deps.boss.work<{ disparoId: string }>(FILA_DISPARO, async (jobs) => {
    for (const job of jobs) {
      await processarDisparo(deps, job.data.disparoId);
    }
  });
}

/** Garante a conversa do wa_id SEM tocar a janela (template não abre janela). */
async function conversaDoWaId(db: Db, waId: string): Promise<string> {
  const [existente] = await db
    .insert(conversa)
    .values({ id: newTraceId(), waId })
    .onConflictDoNothing({ target: conversa.waId })
    .returning({ id: conversa.id });
  if (existente) return existente.id;
  const [conv] = await db.select({ id: conversa.id }).from(conversa).where(eq(conversa.waId, waId));
  if (!conv) throw new Error(`conversa de ${waId} sumiu na corrida`);
  return conv.id;
}

export async function processarDisparo(deps: DisparoWorkerDeps, disparoId: string): Promise<void> {
  const { db, gateway, logger } = deps;
  const [d] = await db
    .select({
      id: disparo.id,
      status: disparo.status,
      variaveis: disparo.variaveis,
      nome: modeloMensagem.nome,
      idioma: modeloMensagem.idioma,
      corpo: modeloMensagem.corpo,
      rodape: modeloMensagem.rodape,
    })
    .from(disparo)
    .innerJoin(modeloMensagem, eq(modeloMensagem.id, disparo.modeloId))
    .where(eq(disparo.id, disparoId));
  if (d?.status !== 'enviando') return; // inexistente ou já concluído (reprocesso)

  const globais = (Array.isArray(d.variaveis) ? d.variaveis : []) as string[];

  const pendentes = await db
    .select()
    .from(disparoDestinatario)
    .where(
      and(eq(disparoDestinatario.disparoId, disparoId), eq(disparoDestinatario.status, 'pendente')),
    )
    .orderBy(asc(disparoDestinatario.id));

  /**
   * 044: a conferência acontece TAMBÉM aqui, não só na criação. Entre criar o
   * disparo e ele sair, alguém pode pedir para sair — e é justamente durante um
   * disparo grande que isso acontece, porque as primeiras mensagens já saíram.
   * Uma consulta para a lista inteira: 500 idas ao banco fariam a conferência
   * virar candidata a "otimizar depois", e ela não é opcional.
   */
  const suprimidos = await suprimidosEntre(
    db,
    pendentes.map((p) => p.waId),
  );

  for (const dest of pendentes) {
    if (suprimidos.has(dest.waId)) {
      await db
        .update(disparoDestinatario)
        .set({
          status: 'recusado',
          erro: 'contato na lista de supressão',
          atualizadoEm: new Date(),
        })
        .where(eq(disparoDestinatario.id, dest.id));
      logger.info({ disparoId, waId: dest.waId }, 'disparo: destinatário suprimido — não enviado');
      continue;
    }
    /**
     * 044: as variáveis do destinatário vencem as globais. `null` (todo disparo
     * da 013) cai no global — a leitura fica aqui, e não numa query com
     * `COALESCE`, para o texto gravado na thread ser renderizado com o MESMO
     * array que foi enviado. Renderizar fora do laço, como antes, gravaria na
     * conversa de todo mundo o texto do primeiro.
     */
    const variaveis = Array.isArray(dest.variaveis) ? (dest.variaveis as string[]) : globais;
    const textoRenderizado =
      renderizarCorpo(d.corpo, variaveis) + (d.rodape ? `\n\n${d.rodape}` : '');
    try {
      const { waMessageId } = await gateway.sendTemplate({
        to: dest.waId,
        nome: d.nome,
        idioma: d.idioma,
        variaveis,
      });
      const conversaId = await conversaDoWaId(db, dest.waId);
      await db.transaction(async (tx) => {
        await tx.insert(mensagem).values({
          id: newTraceId(),
          conversaId,
          direcao: 'out',
          autor: 'campanha',
          waMessageId,
          texto: textoRenderizado,
          status: 'enviada',
        });
        await tx
          .update(disparoDestinatario)
          .set({ status: 'enviado', waMessageId, atualizadoEm: new Date() })
          .where(eq(disparoDestinatario.id, dest.id));
      });
    } catch (err) {
      // 013: falha por destinatário marca SÓ ele — o disparo segue
      await db
        .update(disparoDestinatario)
        .set({
          status: 'falha',
          erro: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          atualizadoEm: new Date(),
        })
        .where(eq(disparoDestinatario.id, dest.id));
      logger.warn({ err, disparoId, waId: dest.waId }, 'disparo: falha em destinatário');
    }
  }

  await db
    .update(disparo)
    .set({ status: 'concluido', atualizadoEm: new Date() })
    .where(eq(disparo.id, disparoId));
}
