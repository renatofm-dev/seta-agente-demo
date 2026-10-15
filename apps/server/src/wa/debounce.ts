import { newTraceId } from '@seta/observability';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_DEBOUNCE } from '../boss.js';
import type { Db } from '../db/index.js';
import { mensagem, turno } from '../db/schema.js';
import { agendarDebounce } from './inbound.js';

/**
 * Debouncer: no disparo, se ainda não houve `debounceMs` de silêncio desde a
 * última mensagem, re-agenda pelo tempo restante; senão agrega as mensagens
 * pendentes num único turno e entrega ao handler (runtime do agente — spec 005).
 */

export interface TurnoPronto {
  readonly id: string;
  readonly conversaId: string;
  readonly textoAgregado: string;
  /**
   * wamid da ÚLTIMA mensagem recebida que entrou neste turno. Existe porque a
   * Meta só mostra "digitando…" com o id de uma mensagem RECEBIDA, e o turno é
   * o único lugar que sabe qual foi. `null` ⇒ o indicador não aparece (nunca
   * acontece pelo webhook, onde a coluna é UNIQUE e obrigatória).
   */
  readonly waMessageIdUltima: string | null;
}

// #46: heurística barata da janela adaptativa — quem "termina a frase" espera
// menos; quem claramente vai continuar digitando ganha mais silêncio.
const RE_FECHO = /[?!.…]$/;
const RE_CONTINUACAO =
  /(?:\b(?:e|mas|ou|aí|ai|então|entao|que|também|tambem|porque|pra|para|com|de|do|da|no|na|meu|minha)|[,:;-])$/i;
const CURTA_MENOS_DE = 15;

/**
 * Janela de silêncio efetiva para a ÚLTIMA mensagem pendente:
 * - termina com pontuação de fecho (?!.…) → 0.6× (latência menor p/ quem fechou)
 * - termina em conectivo/vírgula ou é muito curta → 1.5× (frase vem aí)
 * - caso contrário → a base.
 */
export function janelaAdaptativa(texto: string, baseMs: number): number {
  const t = texto.trim();
  if (RE_FECHO.test(t)) return Math.round(baseMs * 0.6);
  if (t.length < CURTA_MENOS_DE || RE_CONTINUACAO.test(t)) return Math.round(baseMs * 1.5);
  return baseMs;
}

export interface TurnoHandler {
  processar(turno: TurnoPronto): Promise<void>;
}

export interface DebounceDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly debounceMs: number;
  readonly handler: TurnoHandler;
  readonly logger: Logger;
  /**
   * Gate do HITL (007): retorna false para NÃO agregar turno (bot silenciado —
   * ticket aguardando/atendido por humano). Ausente ⇒ sempre permite.
   */
  readonly ticketGate?: (conversaId: string) => Promise<boolean>;
  /** #28: turnos processados em paralelo (conversas diferentes). Default 3. */
  readonly turnosConcorrentes?: number;
}

export async function registerDebounceWorker(deps: DebounceDeps): Promise<void> {
  const concorrencia = Math.max(1, deps.turnosConcorrentes ?? 3);
  // #28: N pollers independentes (padrão pg-boss v12 p/ concorrência) — um
  // turno lento não segura mais as outras conversas. MESMA conversa continua
  // serial via fila em memória (processo único na POC; multi-instância: #33).
  const filaPorConversa = new Map<string, Promise<void>>();
  const processarSerialPorConversa = (conversaId: string): Promise<void> => {
    const anterior = filaPorConversa.get(conversaId) ?? Promise.resolve();
    const atual = anterior.then(() => processarDisparo(deps, conversaId));
    const corrente = atual.catch(() => {});
    filaPorConversa.set(conversaId, corrente);
    void corrente.then(() => {
      if (filaPorConversa.get(conversaId) === corrente) filaPorConversa.delete(conversaId);
    });
    return atual;
  };
  for (let i = 0; i < concorrencia; i++) {
    await deps.boss.work<{ conversaId: string }>(FILA_DEBOUNCE, async (jobs) => {
      for (const job of jobs) {
        await processarSerialPorConversa(job.data.conversaId);
      }
    });
  }
}

async function processarDisparo(deps: DebounceDeps, conversaId: string): Promise<void> {
  const pendentes = await deps.db
    .select()
    .from(mensagem)
    .where(
      and(
        eq(mensagem.conversaId, conversaId),
        eq(mensagem.direcao, 'in'),
        isNull(mensagem.turnoId),
      ),
    )
    .orderBy(asc(mensagem.criadoEm));
  if (pendentes.length === 0) return;

  // HITL: bot silenciado ⇒ mensagem NÃO gera turno; fica pendente até devolver
  if (deps.ticketGate && !(await deps.ticketGate(conversaId))) return;

  const ultima = pendentes[pendentes.length - 1] as (typeof pendentes)[number];
  const silencioMs = Date.now() - ultima.criadoEm.getTime();
  // #46: a janela se adapta à última mensagem (fecho encurta, continuação alonga)
  const janelaMs = janelaAdaptativa(ultima.texto, deps.debounceMs);
  if (silencioMs < janelaMs) {
    await agendarDebounce(deps.boss, conversaId, janelaMs - silencioMs);
    return;
  }

  // #33: agregação sob lock — outra instância disparando junto pega 0 linhas
  // (FOR UPDATE SKIP LOCKED) e não cria turno/resposta duplicados
  const novoTurno = await deps.db.transaction(async (tx) => {
    const travadas = await tx
      .select()
      .from(mensagem)
      .where(
        and(
          eq(mensagem.conversaId, conversaId),
          eq(mensagem.direcao, 'in'),
          isNull(mensagem.turnoId),
        ),
      )
      .orderBy(asc(mensagem.criadoEm))
      .for('update', { skipLocked: true });
    if (travadas.length === 0) return null;
    // a LINHA da tabela e o OBJETO do handler deixam de ser a mesma coisa: `turno`
    // tem quatro colunas, e o handler precisa de um dado que não é coluna nenhuma
    const linha = {
      id: newTraceId(),
      conversaId,
      textoAgregado: travadas.map((m) => m.texto).join('\n'),
    };
    await tx.insert(turno).values(linha);
    await tx
      .update(mensagem)
      .set({ turnoId: linha.id })
      .where(
        inArray(
          mensagem.id,
          travadas.map((m) => m.id),
        ),
      );
    const ultimaTravada = travadas[travadas.length - 1];
    return {
      ...linha,
      waMessageIdUltima: ultimaTravada?.waMessageId ?? null,
    } satisfies TurnoPronto;
  });
  if (!novoTurno) return;

  try {
    await deps.handler.processar(novoTurno);
  } catch (err) {
    // falha do handler não pode travar o debouncer; o turno fica persistido
    deps.logger.error({ err, turnoId: novoTurno.id }, 'handler de turno falhou');
  }
}
