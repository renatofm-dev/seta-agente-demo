import type { TraceEvento } from '@seta/agent';
import type { AIProvider } from '@seta/ai-provider';
import {
  type Acao,
  type Candidato,
  type ContextoFluxo,
  type EstadoFluxo,
  iniciar,
  interpretarResposta,
  mensagensEmitida,
  NOME_METODO,
  parsearResposta,
  referenciaCobranca,
  selecionados,
  type Transicao,
  totalSelecionado,
  transicionar,
} from '@seta/cobranca';
import { newTraceId } from '@seta/observability';
import type { PaymentProvider } from '@seta/payment-provider';
import type { Executor, SessionCtx } from '@seta/query-catalog';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_COBRANCA_EMITIR } from '../boss.js';
import type { Db } from '../db/index.js';
import { cobranca, cobrancaTitulo, fluxoCobranca } from '../db/schema.js';
import type { Env } from '../env.js';
import { lerDadosContrato } from './candidatos.js';
import {
  escalarTicketCobranca,
  TRIGGER_APROVACAO_COBRANCA,
  TRIGGER_COBRANCA_BLOQUEADA,
} from './escalar.js';
import type { CobrancaRow, FluxoRow, PagamentosRepo } from './repo.js';

/**
 * Agente de cobrança no turno (014): persiste o estado da máquina do
 * @seta/cobranca por conversa e executa os efeitos (criar a cobrança,
 * enfileirar a emissão, escalar). Quem envia as mensagens é o turno-handler —
 * este módulo só devolve o que dizer.
 */

export type EnvFluxo = Pick<
  Env,
  | 'PAGAMENTO_TETO_SEM_HITL_CENTAVOS'
  | 'PAGAMENTO_MAX_COBRANCAS_DIA'
  | 'PAGAMENTO_DIAS_VENCIMENTO'
  | 'PAGAMENTO_FLUXO_EXPIRA_MIN'
>;

export interface FluxoDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly executor: Executor;
  readonly repo: PagamentosRepo;
  readonly provider: AIProvider | null;
  readonly psp: PaymentProvider;
  readonly env: EnvFluxo;
  readonly logger: Logger;
}

export interface ContextoTurno {
  readonly conversaId: string;
  readonly turnoId: string;
  readonly session: SessionCtx;
  readonly textoUsuario: string;
}

export interface ResultadoFluxo {
  readonly mensagens: readonly string[];
  readonly escalado: boolean;
  readonly escaladoTrigger: string | null;
  readonly eventos: readonly TraceEvento[];
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  /** true ⇒ o fluxo saiu da frente: o agente geral responde este turno. */
  readonly abandonado: boolean;
  readonly cobrancaId: string | null;
}

/** YYYY-MM-DD local de hoje + n dias. */
export function dataMaisDias(n: number, base = new Date()): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function estadoDe(row: FluxoRow): EstadoFluxo {
  return {
    etapa: row.etapa,
    candidatos: row.candidatos as Candidato[],
    selecao: row.selecao as string[],
    metodo: row.metodo,
    naoEntendi: row.naoEntendi,
    encerramento: (row.encerramento as EstadoFluxo['encerramento']) ?? null,
  };
}

async function salvarEstado(
  db: Db,
  id: string,
  estado: EstadoFluxo,
  extras: { cobrancaId?: string | null } = {},
): Promise<void> {
  await db
    .update(fluxoCobranca)
    .set({
      etapa: estado.etapa,
      encerramento: estado.encerramento,
      selecao: [...estado.selecao],
      metodo: estado.metodo,
      naoEntendi: estado.naoEntendi,
      ...(extras.cobrancaId !== undefined ? { cobrancaId: extras.cobrancaId } : {}),
      atualizadoEm: new Date(),
    })
    .where(eq(fluxoCobranca.id, id));
}

function resultado(
  t: Transicao,
  extras: Partial<ResultadoFluxo> & { etapaAntes: string; acao: string },
): ResultadoFluxo {
  return {
    mensagens: t.mensagens,
    escalado: extras.escalado ?? false,
    escaladoTrigger: extras.escaladoTrigger ?? null,
    eventos: [
      {
        tipo: 'cobranca',
        etapa: extras.etapaAntes,
        acao: extras.acao,
        ...(extras.cobrancaId ? { cobrancaId: extras.cobrancaId } : {}),
      },
    ],
    tokensEntrada: extras.tokensEntrada ?? 0,
    tokensSaida: extras.tokensSaida ?? 0,
    abandonado: extras.abandonado ?? false,
    cobrancaId: extras.cobrancaId ?? null,
  };
}

async function contextoFluxo(
  deps: FluxoDeps,
  ctx: ContextoTurno,
  dados: { contratoStatus: ContextoFluxo['contratoStatus']; distratoEmAnalise: boolean },
): Promise<ContextoFluxo> {
  const [contato, cobrancasHoje] = await Promise.all([
    deps.repo.contatoDaConversa(ctx.conversaId),
    deps.repo.cobrancasHoje(ctx.conversaId),
  ]);
  return {
    tetoCentavos: deps.env.PAGAMENTO_TETO_SEM_HITL_CENTAVOS,
    maxPorDia: deps.env.PAGAMENTO_MAX_COBRANCAS_DIA,
    cobrancasHoje,
    contratoStatus: dados.contratoStatus,
    distratoEmAnalise: dados.distratoEmAnalise,
    temDocumento: Boolean(contato?.documento),
  };
}

/** Bloqueio/limite ⇒ ticket para humano com o motivo humano-legível. */
async function escalarBloqueio(deps: FluxoDeps, ctx: ContextoTurno, t: Transicao) {
  const motivo = `fluxo de pagamento bloqueado: ${t.estado.encerramento ?? 'bloqueado'}`;
  await escalarTicketCobranca(deps.db, ctx.conversaId, TRIGGER_COBRANCA_BLOQUEADA, motivo, {
    refId: ctx.turnoId,
    textoUsuario: ctx.textoUsuario,
  });
}

export async function iniciarFluxo(deps: FluxoDeps, ctx: ContextoTurno): Promise<ResultadoFluxo> {
  const dados = await lerDadosContrato(deps.executor, ctx.session);
  const contexto = await contextoFluxo(deps, ctx, dados);
  const t = iniciar(dados.candidatos, contexto);

  // um fluxo ativo antigo (ex.: expirado) sai da frente antes do novo entrar
  const anterior = await deps.repo.fluxoAtivo(ctx.conversaId);
  if (anterior) {
    await salvarEstado(deps.db, anterior.id, {
      ...estadoDe(anterior),
      etapa: 'encerrado',
      encerramento: 'expirado',
    });
  }
  await deps.db.insert(fluxoCobranca).values({
    id: newTraceId(),
    conversaId: ctx.conversaId,
    contratoId: ctx.session.clienteId,
    etapa: t.estado.etapa,
    encerramento: t.estado.encerramento,
    candidatos: [...t.estado.candidatos],
    selecao: [...t.estado.selecao],
    metodo: t.estado.metodo,
    naoEntendi: 0,
    expiraEm: new Date(Date.now() + deps.env.PAGAMENTO_FLUXO_EXPIRA_MIN * 60_000),
  });

  if (t.efeito === 'escalar_bloqueio') {
    await escalarBloqueio(deps, ctx, t);
    return resultado(t, {
      etapaAntes: 'inicio',
      acao: 'iniciar',
      escalado: true,
      escaladoTrigger: TRIGGER_COBRANCA_BLOQUEADA,
    });
  }
  return resultado(t, { etapaAntes: 'inicio', acao: 'iniciar' });
}

export async function continuarFluxo(
  deps: FluxoDeps,
  fluxo: FluxoRow,
  ctx: ContextoTurno,
): Promise<ResultadoFluxo> {
  const estado = estadoDe(fluxo);
  if (fluxo.expiraEm.getTime() < Date.now()) {
    // sem resposta por muito tempo: sai da frente em silêncio (o classificador
    // reinicia se o cliente disser "quero pagar" de novo)
    await salvarEstado(deps.db, fluxo.id, {
      ...estado,
      etapa: 'encerrado',
      encerramento: 'expirado',
    });
    return {
      mensagens: [],
      escalado: false,
      escaladoTrigger: null,
      eventos: [{ tipo: 'cobranca', etapa: estado.etapa, acao: 'expirado' }],
      tokensEntrada: 0,
      tokensSaida: 0,
      abandonado: true,
      cobrancaId: null,
    };
  }

  let acao: Acao | null = parsearResposta(ctx.textoUsuario, estado);
  let tokens = { tokensEntrada: 0, tokensSaida: 0 };
  if (!acao) {
    if (deps.provider) {
      const i = await interpretarResposta(deps.provider, estado, ctx.textoUsuario);
      acao = i.acao;
      tokens = { tokensEntrada: i.tokensEntrada, tokensSaida: i.tokensSaida };
    } else {
      acao = { tipo: 'nao_entendi' };
    }
  }

  const contexto = await contextoFluxo(deps, ctx, {
    contratoStatus: null,
    distratoEmAnalise: false,
  });
  const t = transicionar(estado, acao, contexto);
  const base = { etapaAntes: estado.etapa, acao: acao.tipo, ...tokens };

  if (t.estado.encerramento === 'abandonado') {
    await salvarEstado(deps.db, fluxo.id, t.estado);
    return resultado(t, { ...base, abandonado: true });
  }

  if (t.efeito === 'emitir' || t.efeito === 'emitir_com_aprovacao') {
    const r = await criarCobranca(deps, ctx, t, t.efeito === 'emitir_com_aprovacao');
    await salvarEstado(deps.db, fluxo.id, t.estado, { cobrancaId: r.cobrancaId });
    return {
      ...resultado(t, { ...base, cobrancaId: r.cobrancaId }),
      mensagens: r.mensagens ?? t.mensagens,
      escalado: r.escalado,
      escaladoTrigger: r.escalado ? TRIGGER_APROVACAO_COBRANCA : null,
    };
  }

  await salvarEstado(deps.db, fluxo.id, t.estado);
  return resultado(t, base);
}

interface CriacaoCobranca {
  readonly cobrancaId: string;
  /** Mensagens que SUBSTITUEM as da transição (ex.: reenvio de cobrança já emitida). */
  readonly mensagens: readonly string[] | null;
  readonly escalado: boolean;
}

/**
 * Cria a cobrança (emitindo | aguardando_aprovacao) + títulos na mesma
 * transação e enfileira a emissão DEPOIS do commit. Idempotência: mesma
 * referência com cobrança aberta ⇒ reaproveita (mesmo método) ou troca
 * (método diferente: a antiga é cancelada, no banco e no PSP pelo worker).
 */
async function criarCobranca(
  deps: FluxoDeps,
  ctx: ContextoTurno,
  t: Transicao,
  precisaAprovacao: boolean,
): Promise<CriacaoCobranca> {
  const estado = t.estado;
  const metodo = estado.metodo;
  if (!metodo) throw new Error('confirmação sem método');
  const titulos = selecionados(estado);
  const referencia = referenciaCobranca(
    ctx.session.clienteId,
    titulos.map((c) => c.tituloId),
  );
  const total = totalSelecionado(estado);

  const aberta = await deps.repo.cobrancaAbertaPorReferencia(referencia);
  if (aberta) {
    const reaproveitada = await reaproveitar(deps, aberta, metodo);
    if (reaproveitada) return reaproveitada;
  }

  const id = newTraceId();
  const status = precisaAprovacao ? 'aguardando_aprovacao' : 'emitindo';
  await deps.db.transaction(async (tx) => {
    if (aberta) {
      await tx
        .update(cobranca)
        .set({ status: 'cancelada', motivo: `trocada por ${metodo}`, atualizadoEm: new Date() })
        .where(eq(cobranca.id, aberta.id));
    }
    await tx.insert(cobranca).values({
      id,
      conversaId: ctx.conversaId,
      contratoId: ctx.session.clienteId,
      referenciaExterna: referencia,
      status,
      metodo,
      valorCentavos: total,
      vencimentoPsp: dataMaisDias(deps.env.PAGAMENTO_DIAS_VENCIMENTO),
      psp: deps.psp.nome,
    });
    await tx.insert(cobrancaTitulo).values(
      titulos.map((c) => ({
        cobrancaId: id,
        tituloId: c.tituloId,
        origem: c.origem,
        parcela: c.parcela,
        totalParcelas: c.totalParcelas,
        valorCentavos: c.valorCentavos,
        vencimento: c.vencimento,
      })),
    );
  });

  if (precisaAprovacao) {
    await escalarTicketCobranca(
      deps.db,
      ctx.conversaId,
      TRIGGER_APROVACAO_COBRANCA,
      `cobrança de ${(total / 100).toFixed(2).replace('.', ',')} reais (${NOME_METODO[metodo]}) acima do teto — aprovar em /cobrancas`,
      { refId: id, textoUsuario: ctx.textoUsuario },
    );
    return { cobrancaId: id, mensagens: null, escalado: true };
  }
  await deps.boss.send(FILA_COBRANCA_EMITIR, {
    cobrancaId: id,
    ...(aberta?.pspCobrancaId ? { cancelarPspId: aberta.pspCobrancaId } : {}),
  });
  return { cobrancaId: id, mensagens: null, escalado: false };
}

/** Cobrança aberta com a mesma referência: reenvia (mesmo método) ou deixa criar outra. */
async function reaproveitar(
  deps: FluxoDeps,
  aberta: CobrancaRow,
  metodo: NonNullable<EstadoFluxo['metodo']>,
): Promise<CriacaoCobranca | null> {
  if (aberta.status === 'aguardando_aprovacao') {
    return {
      cobrancaId: aberta.id,
      mensagens: [
        'Esse pagamento já está aguardando a aprovação de um atendente — assim que liberar, te envio aqui. 🙂',
      ],
      escalado: false,
    };
  }
  if (aberta.status === 'emitindo') {
    return {
      cobrancaId: aberta.id,
      mensagens: ['Esse pagamento já está sendo gerado — te envio aqui em instantes. ⏳'],
      escalado: false,
    };
  }
  if (aberta.status === 'emitida' && aberta.metodo === metodo && aberta.urlFatura) {
    return {
      cobrancaId: aberta.id,
      mensagens: mensagensEmitida({
        metodo,
        valorCentavos: aberta.valorCentavos,
        vencimento: aberta.vencimentoPsp,
        urlFatura: aberta.urlFatura,
        urlBoleto: aberta.urlBoleto,
        linhaDigitavel: aberta.linhaDigitavel,
        pixCopiaCola: aberta.pixCopiaCola,
        reenvio: true,
      }),
      escalado: false,
    };
  }
  deps.logger.info(
    { cobrancaId: aberta.id, de: aberta.metodo, para: metodo },
    'cobrança aberta com outro método — será cancelada e reemitida',
  );
  return null; // método diferente: criarCobranca cancela a antiga e cria a nova
}
