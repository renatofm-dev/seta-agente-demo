import {
  ErpAuthError,
  ErpBusinessError,
  type ErpWriter,
  mesmaReserva,
  type UtilizacaoErp,
} from '@seta/erp-api-tse';
import { TEXTO_FALHA_RESERVA, textoReservaConfirmada } from '@seta/reserva';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_ERP_RESERVA } from '../boss.js';
import type { Db } from '../db/index.js';
import { erpEscrita, reserva } from '../db/schema.js';
import { enqueueOutbound } from '../wa/outbox.js';
import { chaveReserva } from './chave.js';
import { escalarTicketReserva, TRIGGER_FALHA_RESERVA } from './escalar.js';
import type { ReservaRow } from './repo.js';

/**
 * 038 — a reserva chega ao ERP. **Duas fases**, cada uma com guarda própria,
 * porque nenhuma das duas é idempotente no TSE e o efeito colateral da primeira
 * é irreversível sem cancelamento manual: uma utilização criada segura pontos do
 * cotista.
 *
 *   A. `CriarUtilizacaoContrato` (com os hóspedes inline)  → `erp_utilizacao_id`
 *   B. `ConfirmarUtilizacaoContrato/{id}`                  → `confirmada`
 *
 * Diferente da baixa (036), aqui **não existe campo de referência externa** para
 * carimbar: o reconhecimento da própria escrita é por CHAVE NATURAL (semana,
 * hotel, tipo de UH, lotação).
 */

export interface ReservaWorkerDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly writer: ErpWriter;
  readonly logger: Logger;
}

export type ResultadoReserva = 'confirmada' | 'ja-resolvida' | 'falha' | 'adotada';

export async function processarReserva(
  deps: ReservaWorkerDeps,
  reservaId: string,
): Promise<ResultadoReserva> {
  const chave = chaveReserva(reservaId);
  /** Guarda 1: só uma execução tira a linha de `pendente`. */
  const [escrita] = await deps.db
    .update(erpEscrita)
    .set({ tentativas: sql`${erpEscrita.tentativas} + 1`, atualizadoEm: new Date() })
    .where(and(eq(erpEscrita.chave, chave), eq(erpEscrita.estado, 'pendente')))
    .returning();
  if (!escrita) {
    deps.logger.info({ chave }, 'reserva já resolvida — nada a fazer no ERP');
    return 'ja-resolvida';
  }
  const [linha] = await deps.db.select().from(reserva).where(eq(reserva.id, reservaId));
  if (!linha) {
    await concluir(deps, chave, 'falha', 'reserva inexistente');
    return 'falha';
  }

  try {
    const { utilizacao, adotada } = await garantirUtilizacao(deps, linha, escrita.tentativas);
    await confirmar(deps, linha, utilizacao);
    await concluir(deps, chave, 'confirmada', null, utilizacao.id);
    await avisar(deps, linha, utilizacao.id);
    deps.logger.info({ chave, erpId: utilizacao.id }, 'reserva confirmada no ERP');
    return adotada ? 'adotada' : 'confirmada';
  } catch (err) {
    const definitivo = err instanceof ErpAuthError || err instanceof ErpBusinessError;
    const mensagem = err instanceof Error ? err.message : String(err);
    if (!definitivo) {
      await deps.db
        .update(erpEscrita)
        .set({ erro: mensagem, atualizadoEm: new Date() })
        .where(eq(erpEscrita.chave, chave));
      throw err; // pg-boss re-tenta com backoff
    }
    await concluir(deps, chave, 'falha', mensagem);
    await deps.db
      .update(reserva)
      .set({ status: 'falha', motivo: mensagem.slice(0, 300), atualizadoEm: new Date() })
      .where(eq(reserva.id, reservaId));
    await escalarFalha(deps, linha, mensagem);
    deps.logger.error({ chave, err: mensagem }, 'reserva recusada pelo ERP — escalada para humano');
    return 'falha';
  }
}

/**
 * Fase A. A partir da 2ª tentativa, PERGUNTA ao ERP antes de criar: a tentativa
 * anterior pode ter chegado e só a resposta ter se perdido — e criar de novo
 * queimaria os pontos do cotista duas vezes.
 */
async function garantirUtilizacao(
  deps: ReservaWorkerDeps,
  linha: ReservaRow,
  tentativas: number,
): Promise<{ utilizacao: UtilizacaoErp; adotada: boolean }> {
  if (linha.erpUtilizacaoId) {
    const lida = await deps.writer.lerUtilizacao(linha.erpUtilizacaoId);
    if (lida) return { utilizacao: lida, adotada: true };
  }
  if (tentativas > 1) {
    const achada = await adotarPorChaveNatural(deps, linha);
    if (achada) {
      await gravarErpId(deps, linha.id, achada.id);
      deps.logger.warn(
        { reservaId: linha.id, erpId: achada.id },
        'read-back: a utilização já existia no ERP — NÃO criada de novo',
      );
      return { utilizacao: achada, adotada: true };
    }
  }
  const criada = await deps.writer.criarUtilizacao({
    contratoId: linha.contratoId,
    idHotel: linha.idHotel,
    idTipoUh: linha.idTipoUh,
    checkIn: linha.checkIn,
    checkOut: linha.checkOut,
    adultos: linha.adultos,
    criancas: linha.criancas,
    hospedes: (
      linha.hospedes as {
        nome: string;
        sobrenome: string | null;
        cpf: string | null;
        principal: boolean;
      }[]
    ).map((h) => ({
      nome: h.nome,
      sobrenome: h.sobrenome,
      cpf: h.cpf,
      principal: h.principal,
    })),
  });
  // UPDATE isolado, ANTES de qualquer outra coisa: morrer aqui é seguro, porque
  // a próxima tentativa vê o id e pula direto para a confirmação
  await gravarErpId(deps, linha.id, criada.id);
  return { utilizacao: criada, adotada: false };
}

async function adotarPorChaveNatural(
  deps: ReservaWorkerDeps,
  linha: ReservaRow,
): Promise<UtilizacaoErp | null> {
  try {
    const existentes = await deps.writer.listarUtilizacoes(linha.contratoId);
    return (
      existentes.find((u) =>
        mesmaReserva(u, {
          checkIn: linha.checkIn,
          checkOut: linha.checkOut,
          idHotel: linha.idHotel,
          idTipoUh: linha.idTipoUh,
          pagantes: linha.adultos + linha.criancas,
        }),
      ) ?? null
    );
  } catch (err) {
    deps.logger.warn({ err }, 'read-back da reserva falhou — seguindo como não criada');
    return null;
  }
}

async function gravarErpId(deps: ReservaWorkerDeps, id: string, erpId: string): Promise<void> {
  await deps.db
    .update(reserva)
    .set({ status: 'criada', erpUtilizacaoId: erpId, atualizadoEm: new Date() })
    .where(eq(reserva.id, id));
}

/** Fase B. Idem: confere antes de reconfirmar. */
async function confirmar(
  deps: ReservaWorkerDeps,
  linha: ReservaRow,
  utilizacao: UtilizacaoErp,
): Promise<void> {
  if (!utilizacao.confirmada) {
    await deps.writer.confirmarUtilizacao(utilizacao.id);
  }
  await deps.db
    .update(reserva)
    .set({ status: 'confirmada', atualizadoEm: new Date() })
    .where(eq(reserva.id, linha.id));
}

async function concluir(
  deps: ReservaWorkerDeps,
  chave: string,
  estado: 'confirmada' | 'falha',
  erro: string | null,
  erpId: string | null = null,
): Promise<void> {
  await deps.db
    .update(erpEscrita)
    .set({ estado, erpId, erro, atualizadoEm: new Date() })
    .where(eq(erpEscrita.chave, chave));
}

async function avisar(deps: ReservaWorkerDeps, linha: ReservaRow, erpId: string): Promise<void> {
  await enqueueOutbound(
    { db: deps.db, boss: deps.boss },
    {
      conversaId: linha.conversaId,
      chave: `reserva:${linha.id}:confirmada`,
      texto: textoReservaConfirmada({
        hotel: linha.hotel,
        tipoUh: linha.tipoUh,
        checkIn: linha.checkIn,
        checkOut: linha.checkOut,
        erpId,
      }),
      autor: 'bot',
    },
  );
}

/**
 * Falha definitiva escala, e **nunca cancela sozinho**: se a confirmação na
 * verdade pegou, um cancelamento automático destruiria uma reserva real. O
 * ticket leva o `IdUtilizacaoContrato` justamente para o humano decidir.
 */
async function escalarFalha(
  deps: ReservaWorkerDeps,
  linha: ReservaRow,
  motivo: string,
): Promise<void> {
  await escalarTicketReserva(
    deps.db,
    linha.conversaId,
    TRIGGER_FALHA_RESERVA,
    `reserva ${linha.checkIn}→${linha.checkOut} falhou no ERP` +
      `${linha.erpUtilizacaoId ? ` (utilização ${linha.erpUtilizacaoId} EXISTE e não foi confirmada)` : ''}: ${motivo}`,
    { refId: linha.id },
  );
  await enqueueOutbound(
    { db: deps.db, boss: deps.boss },
    {
      conversaId: linha.conversaId,
      chave: `reserva:${linha.id}:falha`,
      texto: TEXTO_FALHA_RESERVA,
      autor: 'bot',
    },
  ).catch(() => {});
}

export async function registerErpReservaWorker(deps: ReservaWorkerDeps): Promise<void> {
  await deps.boss.work<{ reservaId: string }>(FILA_ERP_RESERVA, async (jobs) => {
    for (const job of jobs) await processarReserva(deps, job.data.reservaId);
  });
}
