import type { AIProvider } from '@seta/ai-provider';
import type { ErpWriter } from '@seta/erp-api-tse';
import { newTraceId } from '@seta/observability';
import type { Executor, SessionCtx } from '@seta/query-catalog';
import {
  apresentarHoteis,
  apresentarSimulacao,
  apresentarTiposUh,
  type ContextoFluxo,
  type Efeito,
  type EstadoFluxo,
  iniciar,
  interpretarResposta,
  parsearResposta,
  TEXTO_FALHA_RESERVA,
  type Transicao,
  transicionar,
} from '@seta/reserva';
import { and, eq, ne } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_ERP_RESERVA } from '../boss.js';
import type { Db } from '../db/index.js';
import { erpEscrita, fluxoReserva, reserva } from '../db/schema.js';
import type { Env } from '../env.js';
import type { PagamentosRepo } from '../pagamentos/repo.js';
import { chaveReserva } from './chave.js';
import {
  escalarTicketReserva,
  TRIGGER_APROVACAO_RESERVA,
  TRIGGER_RESERVA_BLOQUEADA,
} from './escalar.js';
import type { FluxoReservaRow, ReservaRepo } from './repo.js';

/**
 * O fluxo de reserva persistido (038). A máquina de `@seta/reserva` decide; aqui
 * se executa: ler o ERP, gravar o estado, criar a linha de reserva e enfileirar
 * a escrita. Molde de `apps/server/src/pagamentos/fluxo.ts`.
 *
 * O LLM nunca escreve: a criação no ERP só acontece dentro do worker, depois de
 * uma confirmação capturada por máquina determinística, sob chave de
 * idempotência em `erp_escrita`.
 */

export type EnvFluxoReserva = Pick<
  Env,
  'RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS' | 'RESERVA_FLUXO_EXPIRA_MIN'
>;

export interface ReservaFluxoDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly executor: Executor;
  readonly repo: ReservaRepo;
  /** Reusado da 014: é ele que sabe o CPF que o cotista já informou. */
  readonly pagamentos: PagamentosRepo;
  readonly writer: ErpWriter;
  readonly provider: AIProvider | null;
  readonly env: EnvFluxoReserva;
  readonly logger: Logger;
}

export interface ContextoTurnoReserva {
  readonly conversaId: string;
  readonly turnoId: string;
  readonly session: SessionCtx;
  readonly textoUsuario: string;
}

export interface ResultadoFluxoReserva {
  readonly mensagens: readonly string[];
  readonly escalado: boolean;
  readonly escaladoTrigger: string | null;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  /** `true` = o fluxo saiu da frente; o agente geral responde este turno. */
  readonly abandonado: boolean;
  readonly reservaId: string | null;
}

const vazio = (over: Partial<ResultadoFluxoReserva> = {}): ResultadoFluxoReserva => ({
  mensagens: [],
  escalado: false,
  escaladoTrigger: null,
  tokensEntrada: 0,
  tokensSaida: 0,
  abandonado: false,
  reservaId: null,
  ...over,
});

const estadoDe = (row: FluxoReservaRow): EstadoFluxo => ({
  ...(row.estado as EstadoFluxo),
  etapa: row.etapa,
  naoEntendi: row.naoEntendi,
});

async function salvarEstado(
  db: Db,
  id: string,
  estado: EstadoFluxo,
  extras: { reservaId?: string } = {},
): Promise<void> {
  await db
    .update(fluxoReserva)
    .set({
      etapa: estado.etapa,
      encerramento: estado.encerramento ?? null,
      estado,
      naoEntendi: estado.naoEntendi,
      ...(extras.reservaId !== undefined ? { reservaId: extras.reservaId } : {}),
      atualizadoEm: new Date(),
    })
    .where(eq(fluxoReserva.id, id));
}

/** Dados que a máquina precisa e que só o server sabe buscar. */
async function contextoFluxo(
  deps: ReservaFluxoDeps,
  ctx: ContextoTurnoReserva,
  comErp: boolean,
): Promise<ContextoFluxo> {
  const contato = await deps.pagamentos.contatoDaConversa(ctx.conversaId);
  let contratoStatus: ContextoFluxo['contratoStatus'] = null;
  let distratoEmAnalise = false;
  let saldoPontos = Number.POSITIVE_INFINITY;
  if (comErp) {
    const [produto, distrato] = await Promise.all([
      deps.executor.run('contrato.meu_produto', {}, ctx.session).catch(() => null),
      deps.executor.run('contrato.status_cancelamento', {}, ctx.session).catch(() => null),
    ]);
    const status = produto?.rows[0]?.status;
    contratoStatus =
      status === 'ativo' || status === 'cancelado' || status === 'quitado' ? status : null;
    distratoEmAnalise = distrato?.rows[0]?.status === 'em_analise';
  }
  try {
    saldoPontos = await deps.writer.lerSaldoPontos(ctx.session.clienteId);
  } catch (err) {
    deps.logger.warn({ err }, 'não consegui ler o saldo de pontos — sigo sem barrar por pontos');
  }
  return {
    contratoStatus,
    distratoEmAnalise,
    saldoPontos,
    tetoTaxaCentavos: deps.env.RESERVA_TETO_TAXA_SEM_HITL_CENTAVOS,
    // o CPF é o que o cotista JÁ informou à plataforma (014), nunca do modelo
    titular: { nome: contato?.nome ?? '', cpf: contato?.documento ?? null },
  };
}

/**
 * Executa o efeito que a máquina pediu e deixa a própria máquina decidir o
 * próximo passo. Encadeia (hotéis → tipos de UH) com teto de voltas: um efeito
 * que se auto-alimentasse viraria laço.
 */
async function aplicarEfeitos(
  deps: ReservaFluxoDeps,
  fluxoId: string,
  inicial: Transicao,
  ctxFluxo: ContextoFluxo,
  ctx: ContextoTurnoReserva,
): Promise<ResultadoFluxoReserva> {
  let t = inicial;
  const mensagens: string[] = [...t.mensagens];
  for (let volta = 0; volta < 5; volta++) {
    const efeito: Efeito = t.efeito;
    if (efeito === 'nenhum') break;

    if (efeito === 'escalar_bloqueio') {
      await salvarEstado(deps.db, fluxoId, t.estado);
      const escalado = await escalarTicketReserva(
        deps.db,
        ctx.conversaId,
        TRIGGER_RESERVA_BLOQUEADA,
        'reserva bloqueada para este contrato',
        { textoUsuario: ctx.textoUsuario },
      );
      return vazio({
        mensagens,
        escalado,
        escaladoTrigger: escalado ? TRIGGER_RESERVA_BLOQUEADA : null,
      });
    }

    if (efeito === 'criar' || efeito === 'criar_com_aprovacao') {
      const r = await criarReserva(deps, fluxoId, t.estado, ctx, efeito === 'criar_com_aprovacao');
      return vazio({ ...r, mensagens: [...mensagens, ...r.mensagens] });
    }

    try {
      t = await ler(deps, t.estado, efeito, ctxFluxo, ctx.session.clienteId);
    } catch (err) {
      deps.logger.error({ err, efeito }, 'leitura do ERP falhou no fluxo de reserva');
      await salvarEstado(deps.db, fluxoId, {
        ...t.estado,
        etapa: 'encerrado',
        encerramento: 'bloqueado',
      });
      const escalado = await escalarTicketReserva(
        deps.db,
        ctx.conversaId,
        TRIGGER_RESERVA_BLOQUEADA,
        'ERP indisponível durante a reserva',
        { textoUsuario: ctx.textoUsuario },
      );
      return vazio({
        mensagens: [...mensagens, TEXTO_FALHA_RESERVA],
        escalado,
        escaladoTrigger: escalado ? TRIGGER_RESERVA_BLOQUEADA : null,
      });
    }
    mensagens.push(...t.mensagens);
  }
  await salvarEstado(deps.db, fluxoId, t.estado);
  return vazio({ mensagens });
}

/** As três leituras do ERP que a máquina sabe pedir. */
async function ler(
  deps: ReservaFluxoDeps,
  estado: EstadoFluxo,
  efeito: Efeito,
  ctxFluxo: ContextoFluxo,
  contratoId: string,
): Promise<Transicao> {
  if (efeito === 'buscar_hoteis') {
    return apresentarHoteis(estado, await deps.writer.listarHoteis(contratoId));
  }
  if (efeito === 'buscar_tipos_uh') {
    return apresentarTiposUh(estado, await deps.writer.listarTiposUh(estado.idHotel as number));
  }
  const simulacao = await deps.writer.simularUtilizacao({
    contratoId,
    idHotel: estado.idHotel as number,
    idTipoUh: estado.idTipoUh as number,
    checkIn: estado.checkIn as string,
    checkOut: estado.checkOut as string,
    pagantes: (estado.adultos ?? 1) + (estado.criancas ?? 0),
  });
  return apresentarSimulacao(estado, simulacao, ctxFluxo);
}

/**
 * A linha de `reserva` e a intenção de escrita nascem na MESMA transação; o job
 * só é enfileirado depois do commit, e só quando não há aprovação pendente.
 * Acima do teto, quem enfileira é o `POST /aprovar` do console.
 */
async function criarReserva(
  deps: ReservaFluxoDeps,
  fluxoId: string,
  estado: EstadoFluxo,
  ctx: ContextoTurnoReserva,
  comAprovacao: boolean,
): Promise<ResultadoFluxoReserva> {
  const contratoId = ctx.session.clienteId;
  const checkIn = estado.checkIn as string;
  const checkOut = estado.checkOut as string;

  // guarda contra duas conversas pedindo a mesma semana (o índice único é a
  // rede de baixo; esta é a mensagem honesta antes de bater nele)
  const viva = await deps.repo.reservaVivaNoPeriodo(contratoId, checkIn, checkOut);
  if (viva) {
    await salvarEstado(deps.db, fluxoId, estado, { reservaId: viva.id });
    return vazio({
      mensagens: [
        'Você já tem uma reserva para esse período. Um atendente vai confirmar com você.',
      ],
      reservaId: viva.id,
    });
  }

  const id = newTraceId();
  const simulacao = estado.simulacao;
  const status = comAprovacao ? 'aguardando_aprovacao' : 'criando';
  let enfileirar = false;
  await deps.db.transaction(async (tx) => {
    await tx.insert(reserva).values({
      id,
      conversaId: ctx.conversaId,
      contratoId,
      status,
      checkIn,
      checkOut,
      idHotel: estado.idHotel as number,
      hotel: estado.hotel ?? null,
      idTipoUh: estado.idTipoUh as number,
      tipoUh: estado.tipoUh ?? null,
      adultos: estado.adultos ?? 1,
      criancas: estado.criancas ?? 0,
      hospedes: estado.hospedes,
      custoPontos: simulacao?.custoPontos ?? 0,
      taxaCentavos: simulacao?.taxaCentavos ?? 0,
    });
    if (!comAprovacao) {
      const [linha] = await tx
        .insert(erpEscrita)
        .values({
          chave: chaveReserva(id),
          operacao: 'reserva',
          alvo: contratoId,
          payload: { reservaId: id, contratoId, checkIn, checkOut },
        })
        .onConflictDoNothing({ target: erpEscrita.chave })
        .returning({ chave: erpEscrita.chave });
      enfileirar = linha !== undefined;
    }
  });
  await salvarEstado(deps.db, fluxoId, estado, { reservaId: id });

  if (enfileirar) await deps.boss.send(FILA_ERP_RESERVA, { reservaId: id });
  if (comAprovacao) {
    const escalado = await escalarTicketReserva(
      deps.db,
      ctx.conversaId,
      TRIGGER_APROVACAO_RESERVA,
      `reserva com taxa de manutenção acima do teto — aprovar em /reservas`,
      { refId: id, textoUsuario: ctx.textoUsuario },
    );
    return vazio({
      reservaId: id,
      escalado,
      escaladoTrigger: escalado ? TRIGGER_APROVACAO_RESERVA : null,
    });
  }
  return vazio({ reservaId: id });
}

export async function iniciarFluxo(
  deps: ReservaFluxoDeps,
  ctx: ContextoTurnoReserva,
): Promise<ResultadoFluxoReserva> {
  const ctxFluxo = await contextoFluxo(deps, ctx, true);
  const t = iniciar(ctxFluxo);
  const id = newTraceId();
  // encerra o ativo anterior ANTES de inserir: é o que protege o índice único
  await deps.db
    .update(fluxoReserva)
    .set({ etapa: 'encerrado', encerramento: 'expirado', atualizadoEm: new Date() })
    .where(and(eq(fluxoReserva.conversaId, ctx.conversaId), ne(fluxoReserva.etapa, 'encerrado')));
  await deps.db.insert(fluxoReserva).values({
    id,
    conversaId: ctx.conversaId,
    contratoId: ctx.session.clienteId,
    etapa: t.estado.etapa,
    encerramento: t.estado.encerramento ?? null,
    estado: t.estado,
    naoEntendi: t.estado.naoEntendi,
    expiraEm: new Date(Date.now() + deps.env.RESERVA_FLUXO_EXPIRA_MIN * 60_000),
  });
  const r = await aplicarEfeitos(deps, id, t, ctxFluxo, ctx);
  return r;
}

export async function continuarFluxo(
  deps: ReservaFluxoDeps,
  fluxo: FluxoReservaRow,
  ctx: ContextoTurnoReserva,
): Promise<ResultadoFluxoReserva> {
  // expirado: sai de cena em SILÊNCIO; o agente geral responde este turno
  if (fluxo.expiraEm.getTime() < Date.now()) {
    await salvarEstado(deps.db, fluxo.id, {
      ...estadoDe(fluxo),
      etapa: 'encerrado',
      encerramento: 'expirado',
    });
    return vazio({ abandonado: true });
  }

  const estado = estadoDe(fluxo);
  let acao = parsearResposta(ctx.textoUsuario, estado);
  let tokensEntrada = 0;
  let tokensSaida = 0;
  if (acao === null) {
    if (deps.provider) {
      const r = await interpretarResposta(deps.provider, estado, ctx.textoUsuario, {
        traceId: ctx.session.traceId,
      });
      acao = r.acao;
      tokensEntrada = r.tokensEntrada;
      tokensSaida = r.tokensSaida;
    } else {
      acao = { tipo: 'nao_entendi' };
    }
  }

  // na continuação não relê status do contrato: só o que muda de turno a turno
  const ctxFluxo = await contextoFluxo(deps, ctx, false);
  const t = transicionar(estado, acao, ctxFluxo);
  if (t.estado.encerramento === 'abandonado') {
    await salvarEstado(deps.db, fluxo.id, t.estado);
    return vazio({ abandonado: true, tokensEntrada, tokensSaida });
  }
  const r = await aplicarEfeitos(deps, fluxo.id, t, ctxFluxo, ctx);
  return { ...r, tokensEntrada, tokensSaida };
}
