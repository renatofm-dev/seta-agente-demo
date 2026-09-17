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
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FILA_COBRANCA_EMITIR } from '../boss.js';
import type { Db } from '../db/index.js';
import { cobranca, fluxoSdr, venda as vendaTabela } from '../db/schema.js';
import type { Env } from '../env.js';
import type { Comprador, VendaRepo } from '../venda/repo.js';
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
  | 'SDR_DESCONTO_MAX_BPS'
  | 'SDR_FLUXO_EXPIRA_MIN'
  | 'SDR_MAX_PROPOSTAS_DIA'
  // 045
  | 'VENDA_SINAL_CENTAVOS'
  | 'VENDA_ID_PRODUTO'
  | 'PAGAMENTO_DIAS_VENCIMENTO'
>;

export interface SdrFluxoDeps {
  readonly db: Db;
  readonly executor: Executor;
  readonly repo: SdrRepo;
  readonly provider: AIProvider | null;
  readonly env: EnvSdr;
  readonly logger: Logger;
  /**
   * 045: presentes ⇒ o fluxo fecha a venda (emite o sinal e manda o PIX).
   * Ausentes, a máquina nunca chega em `emitir_sinal` porque o aceite continua
   * caindo em `agendamento` — é o degrau que mantém a 015a viva sozinha.
   */
  readonly venda?: VendaFluxoDeps | null;
}

/** 045: o que o fechamento precisa além do que o SDR já tem. */
export interface VendaFluxoDeps {
  readonly repo: VendaRepo;
  readonly boss: PgBoss;
  readonly pspNome: string;
  /** Comprador já conhecido (raia do cotista) — nome e CPF do cadastro. */
  readonly compradorConhecido?: Comprador | null;
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
    comprador: (row.comprador as EstadoFluxo['comprador']) ?? null,
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
      comprador: estado.comprador,
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
    // 045: sem `venda` nas deps o aceite continua indo para o agendamento
    ...(deps.venda
      ? {
          compradorConhecido: deps.venda.compradorConhecido ?? null,
          sinalCentavos: deps.env.VENDA_SINAL_CENTAVOS,
        }
      : {}),
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
    case 'emitir_sinal': {
      const r = await emitirSinal(deps, ctx, fluxo, t.estado, contexto);
      await salvarEstado(deps.db, fluxo.id, t.estado, { propostaId: fluxo.propostaId });
      return resultado(t, { ...base, propostaId: fluxo.propostaId, escalado: r.escalado });
    }
    case 'registrar_venda': {
      // o job só é enfileirado pelo evento de pagamento (ver `sinalPago`); aqui
      // a máquina só fecha o fluxo
      if (fluxo.propostaId)
        await deps.repo.atualizarProposta(fluxo.propostaId, { status: 'aceita' });
      await salvarEstado(deps.db, fluxo.id, t.estado);
      return resultado(t, { ...base, propostaId: fluxo.propostaId });
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

/**
 * 045 — o aceite vira dinheiro.
 *
 * Grava o comprador em `contato` (o `emitir.ts` da 014 recusa emitir sem CPF),
 * cria a `venda` e a `cobranca` do sinal na MESMA transação, e só então
 * enfileira a emissão. A ordem importa: se o processo cair depois do INSERT e
 * antes do job, a venda existe como `sinal_emitido` e aparece no console como
 * pendente — o que é recuperável. O contrário (cobrança emitida sem venda
 * gravada) deixaria dinheiro entrando sem dono.
 *
 * `cobranca.contrato_id` recebe `lead:{id}` no lead frio: a coluna é NOT NULL e
 * na 014 serve para chavear o cliente no PSP, não para apontar um contrato que
 * ainda não existe. Ver a decisão registrada no PR.
 */
async function emitirSinal(
  deps: SdrFluxoDeps,
  ctx: ContextoTurnoSdr,
  fluxo: FluxoSdrRow,
  estado: EstadoFluxo,
  contexto: ContextoFluxo,
): Promise<{ escalado: boolean }> {
  const venda = deps.venda;
  const comprador = estado.comprador;
  const cota = cotaEscolhida(estado);
  if (!venda || !comprador || !cota) {
    deps.logger.error({ fluxoId: fluxo.id }, 'emitir_sinal sem venda/comprador/cota');
    return { escalado: false };
  }

  // uma venda viva por cota: duas conversas não vendem a mesma unidade
  const jaVendida = await venda.repo.vivaPorCota(cota.cotaId);
  if (jaVendida && jaVendida.conversaId !== ctx.conversaId) {
    deps.logger.warn({ cotaId: cota.cotaId }, 'cota já tem venda viva em outra conversa');
    return { escalado: false };
  }
  const existente = await venda.repo.daConversa(ctx.conversaId);
  if (existente && existente.status === 'sinal_emitido') return { escalado: false };

  await venda.repo.garantirContato(ctx.waId, comprador);

  const total = valorOfertadoCentavos(estado, contexto.descontoMaxBps) ?? cota.valorTabelaCentavos;
  const sinal = Math.min(deps.env.VENDA_SINAL_CENTAVOS, total);
  const vendaId = newTraceId();
  const cobrancaId = newTraceId();
  /**
   * Referência pela PROPOSTA, não pela venda: `cobranca_referencia_aberta_uq` é
   * único parcial sobre os status abertos, então duas emissões para a mesma
   * proposta colidem no banco em vez de virarem dois PIX para a mesma pessoa.
   * Com o id da venda (novo a cada chamada) essa proteção não existiria.
   */
  const referencia = `venda:${fluxo.propostaId ?? vendaId}:sinal`;

  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(cobranca).values({
        id: cobrancaId,
        conversaId: ctx.conversaId,
        // ver o comentário do cabeçalho: identificador do PAGADOR, não do contrato
        contratoId: `lead:${fluxo.leadId}`,
        referenciaExterna: referencia,
        status: 'emitindo',
        metodo: 'pix',
        valorCentavos: sinal,
        vencimentoPsp: dataMaisDias(deps.env.PAGAMENTO_DIAS_VENCIMENTO),
        psp: venda.pspNome,
        origem: 'venda',
        propostaId: fluxo.propostaId,
      });
      await tx.insert(vendaTabela).values({
        id: vendaId,
        conversaId: ctx.conversaId,
        leadId: fluxo.leadId,
        propostaId: fluxo.propostaId,
        cobrancaId,
        status: 'sinal_emitido',
        comprador,
        cotaId: cota.cotaId,
        cotaCodigo: cota.cotaCodigo,
        idProduto: deps.env.VENDA_ID_PRODUTO,
        valorCentavos: total,
        sinalCentavos: sinal,
      });
    });
  } catch (err) {
    // `venda_cota_uq` / `cobranca_referencia_aberta_uq`: outra conversa (ou um
    // reenvio) chegou primeiro. Não é erro de sistema — é a trava funcionando,
    // e derrubar o turno por isso seria pior do que não emitir.
    deps.logger.warn({ err, cotaId: cota.cotaId }, '045: sinal não emitido (venda já existe)');
    return { escalado: false };
  }

  await venda.boss.send(FILA_COBRANCA_EMITIR, { cobrancaId });
  deps.logger.info({ vendaId, cobrancaId, sinal }, '045: sinal emitido');
  return { escalado: false };
}

/** Vencimento do PIX do sinal — mesma regra da 014. */
function dataMaisDias(dias: number): string {
  const d = new Date(Date.now() + dias * 86_400_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(d);
}
