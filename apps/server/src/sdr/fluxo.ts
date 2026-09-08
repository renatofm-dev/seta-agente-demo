import type { TraceEvento } from '@seta/agent';
import type { AIProvider } from '@seta/ai-provider';
import { newTraceId } from '@seta/observability';
import type { Executor, SessionCtx } from '@seta/query-catalog';
import {
  type Acao,
  apresentar,
  type ContextoFluxo,
  type CotaDisponivel,
  cotaEscolhida,
  type EstadoFluxo,
  iniciar,
  interpretarResposta,
  type Perfil,
  parsearResposta,
  pisoCentavos,
  referenciaProposta,
  type Transicao,
  transicionar,
  valorOfertadoCentavos,
} from '@seta/sdr';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { fluxoSdr } from '../db/schema.js';
import type { Env } from '../env.js';
import {
  escalarTicketSdr,
  TRIGGER_DESCONTO_ACIMA_ALCADA,
  TRIGGER_SDR_COMERCIAL,
} from './escalar.js';
import { lerEstoque } from './estoque.js';
import type { FluxoSdrRow, SdrRepo } from './repo.js';

/**
 * Agente SDR no turno (015): persiste o estado da máquina do @seta/sdr por
 * conversa e executa os efeitos (ler estoque, gravar a proposta ANTES de
 * enviar, escalar). Quem envia as mensagens é o turno-handler — este módulo
 * só devolve o que dizer. Mesma forma do pagamentos/fluxo.ts da 014.
 */

export type EnvSdr = Pick<
  Env,
  'SDR_DESCONTO_MAX_BPS' | 'SDR_FLUXO_EXPIRA_MIN' | 'SDR_MAX_PROPOSTAS_DIA'
>;

export interface SdrFluxoDeps {
  readonly db: Db;
  readonly executor: Executor;
  readonly repo: SdrRepo;
  readonly provider: AIProvider | null;
  readonly env: EnvSdr;
  readonly logger: Logger;
}

export interface ContextoTurnoSdr {
  readonly conversaId: string;
  readonly turnoId: string;
  readonly waId: string;
  readonly session: SessionCtx;
  readonly textoUsuario: string;
}

export interface ResultadoFluxoSdr {
  readonly mensagens: readonly string[];
  readonly escalado: boolean;
  readonly escaladoTrigger: string | null;
  readonly eventos: readonly TraceEvento[];
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  /** true ⇒ o fluxo saiu da frente: o agente geral responde este turno. */
  readonly abandonado: boolean;
  readonly propostaId: string | null;
}

function estadoDe(row: FluxoSdrRow): EstadoFluxo {
  return {
    etapa: row.etapa,
    perfil: row.perfil as Perfil,
    opcoes: row.opcoes as CotaDisponivel[],
    escolha: row.escolha,
    oferta: row.oferta,
    naoEntendi: row.naoEntendi,
    encerramento: (row.encerramento as EstadoFluxo['encerramento']) ?? null,
  };
}

async function salvarEstado(
  db: Db,
  id: string,
  estado: EstadoFluxo,
  extras: { propostaId?: string | null } = {},
): Promise<void> {
  await db
    .update(fluxoSdr)
    .set({
      etapa: estado.etapa,
      encerramento: estado.encerramento,
      perfil: estado.perfil,
      opcoes: [...estado.opcoes],
      escolha: estado.escolha,
      oferta: estado.oferta,
      naoEntendi: estado.naoEntendi,
      ...(extras.propostaId !== undefined ? { propostaId: extras.propostaId } : {}),
      atualizadoEm: new Date(),
    })
    .where(eq(fluxoSdr.id, id));
}

function resultado(
  t: Transicao,
  extras: Partial<ResultadoFluxoSdr> & { etapaAntes: string; acao: string },
): ResultadoFluxoSdr {
  return {
    mensagens: t.mensagens,
    escalado: extras.escalado ?? false,
    escaladoTrigger: extras.escaladoTrigger ?? null,
    eventos: [
      {
        tipo: 'sdr',
        etapa: extras.etapaAntes,
        acao: extras.acao,
        ...(extras.propostaId ? { propostaId: extras.propostaId } : {}),
      },
    ],
    tokensEntrada: extras.tokensEntrada ?? 0,
    tokensSaida: extras.tokensSaida ?? 0,
    abandonado: extras.abandonado ?? false,
    propostaId: extras.propostaId ?? null,
  };
}

async function contextoFluxo(deps: SdrFluxoDeps, ctx: ContextoTurnoSdr): Promise<ContextoFluxo> {
  return {
    descontoMaxBps: deps.env.SDR_DESCONTO_MAX_BPS,
    maxPropostasDia: deps.env.SDR_MAX_PROPOSTAS_DIA,
    propostasHoje: await deps.repo.propostasHoje(ctx.conversaId),
  };
}

export async function iniciarFluxoSdr(
  deps: SdrFluxoDeps,
  ctx: ContextoTurnoSdr,
): Promise<ResultadoFluxoSdr> {
  const contexto = await contextoFluxo(deps, ctx);
  const t = iniciar(contexto);
  const leadRow = await deps.repo.garantirLead(ctx.waId, ctx.conversaId, ctx.session.traceId);

  // um fluxo ativo antigo (ex.: expirado) sai da frente antes do novo entrar
  const anterior = await deps.repo.fluxoAtivo(ctx.conversaId);
  if (anterior) {
    await salvarEstado(deps.db, anterior.id, {
      ...estadoDe(anterior),
      etapa: 'encerrado',
      encerramento: 'expirado',
    });
  }
  await deps.db.insert(fluxoSdr).values({
    id: newTraceId(),
    conversaId: ctx.conversaId,
    leadId: leadRow.id,
    etapa: t.estado.etapa,
    encerramento: t.estado.encerramento,
    perfil: t.estado.perfil,
    opcoes: [],
    escolha: null,
    oferta: null,
    naoEntendi: 0,
    expiraEm: new Date(Date.now() + deps.env.SDR_FLUXO_EXPIRA_MIN * 60_000),
  });

  if (t.efeito === 'escalar_limite') {
    await escalarTicketSdr(
      deps.db,
      ctx.conversaId,
      TRIGGER_SDR_COMERCIAL,
      `lead atingiu o limite de ${contexto.maxPropostasDia} propostas/dia — comercial assume`,
      { refId: ctx.turnoId, textoUsuario: ctx.textoUsuario },
    );
    return resultado(t, {
      etapaAntes: 'inicio',
      acao: 'iniciar',
      escalado: true,
      escaladoTrigger: TRIGGER_SDR_COMERCIAL,
    });
  }
  if (leadRow.status === 'novo')
    await deps.repo.atualizarLead(leadRow.id, { status: 'qualificando' });
  return resultado(t, { etapaAntes: 'inicio', acao: 'iniciar' });
}

export async function continuarFluxoSdr(
  deps: SdrFluxoDeps,
  fluxo: FluxoSdrRow,
  ctx: ContextoTurnoSdr,
): Promise<ResultadoFluxoSdr> {
  const estado = estadoDe(fluxo);
  if (fluxo.expiraEm.getTime() < Date.now()) {
    await salvarEstado(deps.db, fluxo.id, {
      ...estado,
      etapa: 'encerrado',
      encerramento: 'expirado',
    });
    return {
      mensagens: [],
      escalado: false,
      escaladoTrigger: null,
      eventos: [{ tipo: 'sdr', etapa: estado.etapa, acao: 'expirado' }],
      tokensEntrada: 0,
      tokensSaida: 0,
      abandonado: true,
      propostaId: null,
    };
  }

  let acao: Acao | null = parsearResposta(ctx.textoUsuario, estado);
  let tokens = { tokensEntrada: 0, tokensSaida: 0 };
  if (!acao) {
    if (deps.provider) {
      const i = await interpretarResposta(deps.provider, estado, ctx.textoUsuario, {
        traceId: ctx.session.traceId,
      });
      acao = i.acao;
      tokens = { tokensEntrada: i.tokensEntrada, tokensSaida: i.tokensSaida };
    } else {
      acao = { tipo: 'nao_entendi' };
    }
  }

  const contexto = await contextoFluxo(deps, ctx);
  let t = transicionar(estado, acao, contexto);
  const base = { etapaAntes: estado.etapa, acao: acao.tipo, ...tokens };

  if (t.efeito === 'buscar_estoque') {
    // qualificado: lê o estoque com o perfil e apresenta (ou encerra sem estoque)
    const cotas = await lerEstoque(deps.executor, ctx.session, t.estado.perfil);
    t = apresentar(t.estado, cotas);
    await deps.repo.atualizarLead(fluxo.leadId, { status: 'qualificado', perfil: t.estado.perfil });
  }

  switch (t.efeito) {
    case 'ofertar': {
      const propostaId = await registrarProposta(deps, ctx, fluxo, t.estado, contexto);
      await salvarEstado(deps.db, fluxo.id, t.estado, { propostaId });
      return resultado(t, { ...base, propostaId });
    }
    case 'escalar_alcada': {
      const propostaId = fluxo.propostaId;
      const cota = cotaEscolhida(t.estado);
      const pedido = t.valorPedidoCentavos ?? 0;
      if (propostaId) {
        await deps.repo.atualizarProposta(propostaId, {
          status: 'aguardando_aprovacao',
          valorPedidoCentavos: pedido,
          motivo: 'lead pediu abaixo do piso da alçada',
        });
      }
      const piso = cota ? pisoCentavos(cota.valorTabelaCentavos, contexto.descontoMaxBps) : 0;
      await escalarTicketSdr(
        deps.db,
        ctx.conversaId,
        TRIGGER_DESCONTO_ACIMA_ALCADA,
        `lead pediu ${reais(pedido)} pela cota ${cota?.cotaCodigo ?? '?'} (piso da alçada ${reais(piso)}) — validar proposta`,
        { refId: propostaId ?? ctx.turnoId, textoUsuario: ctx.textoUsuario },
      );
      await salvarEstado(deps.db, fluxo.id, t.estado);
      return resultado(t, {
        ...base,
        propostaId,
        escalado: true,
        escaladoTrigger: TRIGGER_DESCONTO_ACIMA_ALCADA,
      });
    }
    case 'escalar_sem_estoque': {
      await escalarTicketSdr(
        deps.db,
        ctx.conversaId,
        TRIGGER_SDR_COMERCIAL,
        `lead qualificado (${t.estado.perfil.pessoas} pessoas, ${t.estado.perfil.periodos} período(s)/ano) sem cota disponível — comercial vê alternativas`,
        { refId: fluxo.leadId, textoUsuario: ctx.textoUsuario },
      );
      await salvarEstado(deps.db, fluxo.id, t.estado);
      return resultado(t, { ...base, escalado: true, escaladoTrigger: TRIGGER_SDR_COMERCIAL });
    }
    case 'agendar': {
      if (fluxo.propostaId)
        await deps.repo.atualizarProposta(fluxo.propostaId, { status: 'aceita' });
      await deps.repo.atualizarLead(fluxo.leadId, { status: 'agendado', perfil: t.estado.perfil });
      await salvarEstado(deps.db, fluxo.id, t.estado);
      return resultado(t, { ...base, propostaId: fluxo.propostaId });
    }
    default: {
      if (t.estado.encerramento === 'sem_interesse') {
        if (fluxo.propostaId)
          await deps.repo.atualizarProposta(fluxo.propostaId, { status: 'recusada' });
        await deps.repo.atualizarLead(fluxo.leadId, { status: 'perdido' });
      }
      await salvarEstado(deps.db, fluxo.id, t.estado);
      return resultado(t, { ...base, abandonado: t.estado.encerramento === 'abandonado' });
    }
  }
}

function reais(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

/**
 * A proposta é gravada ANTES de a mensagem sair — é a trilha de auditoria e a
 * fonte de verdade da alçada. Uma aberta por lead×cota: a segunda oferta
 * (piso) atualiza a mesma linha em vez de criar outra.
 */
async function registrarProposta(
  deps: SdrFluxoDeps,
  ctx: ContextoTurnoSdr,
  fluxo: FluxoSdrRow,
  estado: EstadoFluxo,
  contexto: ContextoFluxo,
): Promise<string> {
  const cota = cotaEscolhida(estado);
  if (!cota) throw new Error('oferta sem cota escolhida');
  const ofertado =
    valorOfertadoCentavos(estado, contexto.descontoMaxBps) ?? cota.valorTabelaCentavos;
  const piso = pisoCentavos(cota.valorTabelaCentavos, contexto.descontoMaxBps);
  const descontoBps = estado.oferta === 'piso' ? contexto.descontoMaxBps : 0;
  const referencia = referenciaProposta(ctx.waId, cota.cotaId);

  const aberta = await deps.repo.propostaAbertaPorReferencia(referencia);
  if (aberta) {
    await deps.repo.atualizarProposta(aberta.id, {
      valorOfertadoCentavos: ofertado,
      descontoBps,
      status: 'ofertada',
    });
    return aberta.id;
  }
  const criada = await deps.repo.criarProposta({
    id: newTraceId(),
    leadId: fluxo.leadId,
    fluxoId: fluxo.id,
    conversaId: ctx.conversaId,
    cotaId: cota.cotaId,
    cotaCodigo: cota.cotaCodigo,
    referencia,
    valorTabelaCentavos: cota.valorTabelaCentavos,
    valorMinimoCentavos: piso,
    valorOfertadoCentavos: ofertado,
    descontoBps,
    status: 'ofertada',
  });
  await deps.repo.atualizarLead(fluxo.leadId, { status: 'proposta' });
  return criada.id;
}
