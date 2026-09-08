import {
  createAgentRuntime,
  type ResultadoTurno,
  TEXTO_FALLBACK,
  TEXTO_TRANSICAO,
  type TraceEvento,
  toolEscalarParaHumano,
  toolIniciarPagamento,
} from '@seta/agent';
import type { AIProvider, ChatMessage } from '@seta/ai-provider';
import type { ClientConfig } from '@seta/client-config';
import { TEXTO_INTERESSE_COMPRA } from '@seta/cobranca';
import {
  classificarIntencao,
  guardrailPreco,
  intencaoEscala,
  TRIGGER_POR_INTENCAO,
} from '@seta/guardrails';
import { newTraceId, type ObsEmitter } from '@seta/observability';
import type { PaymentProvider } from '@seta/payment-provider';
import { buildToolSpecs, type CatalogIndex, type Executor } from '@seta/query-catalog';
import type { VectorStore } from '@seta/rag';
import type { SkillRegistry } from '@seta/skills';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { contato, conversa, mensagem, sinalAprendizado, ticket, traceTurno } from '../db/schema.js';
import {
  continuarFluxo,
  type EnvFluxo,
  type FluxoDeps,
  iniciarFluxo,
  type ResultadoFluxo,
} from '../pagamentos/fluxo.js';
import type { PagamentosRepo } from '../pagamentos/repo.js';
import { toolCobrancaEmAberto } from '../pagamentos/tool-cobranca-em-aberto.js';
import { toolBuscarConhecimento } from '../rag/tool-buscar-conhecimento.js';
import {
  continuarFluxoSdr,
  type EnvSdr,
  iniciarFluxoSdr,
  type SdrFluxoDeps,
} from '../sdr/fluxo.js';
import type { SdrRepo } from '../sdr/repo.js';
import type { TurnoHandler, TurnoPronto } from './debounce.js';
import { agendarDebounce } from './inbound.js';
import { enqueueOutbound, enviarJobOutbound, inserirOutbound } from './outbox.js';
import { aplicarTransicao, garantirTicket } from './tickets.js';

/**
 * Handler real do turno (substitui o stub da 004): monta o contexto da conversa,
 * roda o grafo do agente e persiste trace_turno SEMPRE — mesmo quando o LLM não
 * está configurado ou o grafo falha.
 */

export interface AgentTurnoHandlerDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  /** null ⇒ LLM não configurado; turno responde fallback honesto. */
  readonly provider: AIProvider | null;
  readonly catalog: CatalogIndex;
  readonly executor: Executor;
  readonly clientConfig: ClientConfig;
  /** null ⇒ turno roda sem skills (009). */
  readonly registry: SkillRegistry | null;
  /** VectorStore da KB (008) — buscar_conhecimento real. */
  readonly store: VectorStore;
  /** Emissor de eventos de observabilidade (010) — fire-and-forget, nunca lança. */
  readonly obs: ObsEmitter;
  readonly logger: Logger;
  readonly turnoTimeoutMs: number;
  readonly resumoACadaTurnos: number;
  /** #46: janela usada para reagendar o debounce após um turno descartado. */
  readonly debounceMs?: number;
  /** 014: fluxo de cobrança; ausente ⇒ turno igual ao de antes da 014. */
  readonly pagamentos?: PagamentosTurnoDeps;
  /** 016: acumulador do decorator de anonimização — drenado para o trace do turno. */
  readonly anonimizacao?: { consumir(traceId: string): TraceEvento | null };
  /** 015: agente SDR da raia sem vínculo; ausente ⇒ lead frio escala como antes. */
  readonly sdr?: SdrTurnoDeps;
}

/** 015: o que o agente SDR precisa além do que o turno já tem. */
export interface SdrTurnoDeps {
  readonly repo: SdrRepo;
  readonly env: EnvSdr;
}

/**
 * 015: o fluxo SDR saiu da frente (2 respostas não entendidas) — o agente
 * geral responde este turno sabendo disso.
 */
const NOTA_FLUXO_SDR_ABANDONADO =
  '\n\nNOTA: o interessado estava num fluxo de qualificação/oferta de cota que ficou sem ' +
  'resposta clara e foi encerrado. Responda à mensagem atual normalmente; se ele voltar a ' +
  'falar em comprar, diga que pode retomar as opções.';

/** 014: o que o agente de cobrança precisa além do que o turno já tem. */
export interface PagamentosTurnoDeps {
  readonly repo: PagamentosRepo;
  readonly psp: PaymentProvider;
  readonly env: EnvFluxo;
}

/** Nota na persona quando o fluxo de cobrança acabou de sair da frente (2 respostas não entendidas). */
const NOTA_FLUXO_ABANDONADO =
  '\n\nATENÇÃO: o cliente estava num fluxo de pagamento que foi encerrado porque as últimas ' +
  'respostas não foram reconhecidas. Responda ao que ele disse agora; se ele quiser pagar ' +
  'parcelas, use a tool iniciar_pagamento.';

/**
 * #46: teto de descartes consecutivos — cliente que digita sem parar recebe
 * resposta mesmo com pendência (inanição nunca).
 */
export const MAX_DESCARTES_CONSECUTIVOS = 2;

/** #47: reconhecimento quando o tema escalado volta com a conversa já na fila. */
export const TEXTO_JA_NA_FILA =
  'Esse assunto já está com a nossa equipe — você está na fila e um atendente ' +
  'assume em instantes. Posso te ajudar com outra coisa enquanto isso? 🙂';

/** O que a fusão decidiu fazer com a resposta do turno. */
type FusaoResultado = 'enviado' | 'fundido' | 'humano_assumiu';

/** Resultado do turno + o que a fusão decidiu (não faz parte do contrato do agent). */
type ResultadoComFusao = ResultadoTurno & {
  readonly fusao: FusaoResultado;
  /** Texto que realmente saiu (pode diferir do draft, ex.: TEXTO_JA_NA_FILA). */
  readonly respostaEnviada: string | null;
};

/**
 * #46/#47: enfileira a resposta SÓ se ainda fizer sentido. Checagem e insert
 * do outbox na MESMA transação, com lock da conversa E do ticket:
 * - atendente assumiu durante o turno (#47) → 'humano_assumiu', descarta;
 * - mensagem nova pendente (#46) → 'fundido', devolve as mensagens do turno a
 *   pendentes e o próximo turno agrega tudo (respeitando o teto de descartes);
 * - senão → 'enviado'.
 * O processInbound (transacional) e o aplicarTransicao serializam com isto.
 */
async function enfileirarComFusao(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  textos: readonly string[],
  opts: { ignorarPendentes?: boolean; seqInicial?: number } = {},
): Promise<FusaoResultado> {
  const seqInicial = opts.seqInicial ?? 1;
  const r = await deps.db.transaction(async (tx) => {
    const [conv] = await tx
      .select({ descartes: conversa.descartesConsecutivos })
      .from(conversa)
      .where(eq(conversa.id, t.conversaId))
      .for('update');
    // #47: corrida do Assumir — com o ticket travado, ou a transição já
    // aconteceu (vemos humano_ativo e descartamos) ou ela espera nosso commit
    const [tk] = await tx
      .select({ status: ticket.status })
      .from(ticket)
      .where(eq(ticket.conversaId, t.conversaId))
      .for('update');
    if (tk?.status === 'humano_ativo') {
      return { resultado: 'humano_assumiu' as const };
    }
    const pendentes = opts.ignorarPendentes
      ? []
      : await tx
          .select({ id: mensagem.id })
          .from(mensagem)
          .where(
            and(
              eq(mensagem.conversaId, t.conversaId),
              eq(mensagem.direcao, 'in'),
              isNull(mensagem.turnoId),
            ),
          )
          .limit(1);
    const descartes = conv?.descartes ?? 0;
    if (pendentes.length > 0 && descartes < MAX_DESCARTES_CONSECUTIVOS) {
      // devolve as mensagens deste turno ao estado pendente: o próximo turno
      // agrega antigas + nova e o contato recebe UMA resposta só
      await tx
        .update(mensagem)
        .set({ turnoId: null })
        .where(and(eq(mensagem.turnoId, t.id), eq(mensagem.direcao, 'in')));
      await tx
        .update(conversa)
        .set({ descartesConsecutivos: descartes + 1 })
        .where(eq(conversa.id, t.conversaId));
      return { resultado: 'fundido' as const };
    }
    if (descartes > 0) {
      await tx
        .update(conversa)
        .set({ descartesConsecutivos: 0 })
        .where(eq(conversa.id, t.conversaId));
    }
    // 014: um turno pode sair em N mensagens (ex.: explicação + código PIX);
    // seq crescente na mesma transação, jobs após o commit — na ordem
    const outboxIds: string[] = [];
    for (const [i, texto] of textos.entries()) {
      const inserido = await inserirOutbound(tx, {
        conversaId: t.conversaId,
        turnoId: t.id,
        seq: seqInicial + i,
        texto,
      });
      if (inserido.outboxId) outboxIds.push(inserido.outboxId);
    }
    return { resultado: 'enviado' as const, outboxIds };
  });
  // o job vai DEPOIS do commit — rollback nunca deixa job órfão na fila
  if (r.resultado === 'enviado') {
    for (const id of r.outboxIds) await enviarJobOutbound(deps.boss, id);
  }
  return r.resultado;
}

export function createAgentTurnoHandler(deps: AgentTurnoHandlerDeps): TurnoHandler {
  return {
    async processar(t: TurnoPronto): Promise<void> {
      const traceId = newTraceId();
      const inicio = Date.now();
      try {
        const resultado = await processarComAgente(deps, t, traceId);
        if (resultado.escalado) {
          await escalarTicket(deps, t, resultado);
        }
        await gravarSinaisDeVerdict(deps, t, resultado);
        emitirObservabilidade(deps, t, traceId, resultado, await ticketIdDe(deps.db, t));
        // #46/#47: turno com resposta descartada fica VISÍVEL no trace
        // (tokens/latência foram reais e entram nas métricas)
        const eventos: TraceEvento[] = [...resultado.eventos];
        // 016: quanto foi anonimizado neste turno (classificador + agente + resumo)
        const anon = deps.anonimizacao?.consumir(traceId);
        if (anon) eventos.push(anon);
        if (resultado.fusao === 'fundido') {
          eventos.push({
            tipo: 'descartado',
            motivo:
              'mensagem nova chegou durante o processamento — resposta descartada; o próximo turno agrega tudo',
          });
        } else if (resultado.fusao === 'humano_assumiu') {
          eventos.push({
            tipo: 'descartado',
            motivo: 'atendente assumiu durante o processamento — resposta do bot descartada',
          });
        }
        // trace por ÚLTIMO: é o marcador de turno completo (ticket e sinais já
        // visíveis); a resposta gravada é a que SAIU (ex.: TEXTO_JA_NA_FILA)
        await gravarTrace(deps.db, t, traceId, {
          ...resultado,
          eventos,
          resposta: resultado.respostaEnviada ?? resultado.resposta,
        });
        if (resultado.fusao === 'fundido') {
          // o próximo disparo agrega as mensagens devolvidas + a recém-chegada
          await agendarDebounce(deps.boss, t.conversaId, deps.debounceMs ?? 10_000);
        }
      } catch (err) {
        // trace persistido SEMPRE — inclusive na falha catastrófica do runtime
        deps.logger.error({ err, turnoId: t.id, traceId }, 'turno falhou — fallback de emergência');
        const eventos: TraceEvento[] = [
          {
            tipo: 'fallback',
            motivo: `erro no runtime: ${err instanceof Error ? err.message : err}`,
          },
        ];
        await enqueueOutbound(
          { db: deps.db, boss: deps.boss },
          { conversaId: t.conversaId, turnoId: t.id, seq: 1, texto: TEXTO_FALLBACK },
        );
        await gravarTrace(deps.db, t, traceId, {
          resposta: TEXTO_FALLBACK,
          escalado: false,
          escaladoTrigger: null,
          fallback: true,
          fallbackMotivo: 'erro no runtime',
          eventos,
          tokensEntrada: 0,
          tokensSaida: 0,
          latenciaMs: Date.now() - inicio,
        }).catch((e) => {
          // último recurso: nunca deixar o job re-tentar por falha do próprio trace
          deps.logger.error({ e, turnoId: t.id }, 'falha ao gravar trace de emergência');
        });
      }
    },
  };
}

async function processarComAgente(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  traceId: string,
): Promise<ResultadoComFusao> {
  const [conv] = await deps.db.select().from(conversa).where(eq(conversa.id, t.conversaId));
  if (!conv) throw new Error(`turno ${t.id} sem conversa`);

  // vínculo verificado vem da tabela contato (seed grava — corte da 000)
  const [vinculo] = await deps.db.select().from(contato).where(eq(contato.waId, conv.waId));
  const clienteId = vinculo?.clienteErpId ?? '';
  // 015: a alçada do SDR entra na sessão como política (bind desconto_max_bps)
  const session = {
    traceId,
    clienteId,
    ...(deps.sdr ? { descontoMaxBps: deps.sdr.env.SDR_DESCONTO_MAX_BPS } : {}),
  };

  // #47: o turno precisa saber se a conversa JÁ está na fila de humano — o
  // bot segue atendendo outros assuntos, sem repetir promessa de escalada
  const [tk] = await deps.db.select().from(ticket).where(eq(ticket.conversaId, t.conversaId));
  const filaHumano = tk?.status === 'aguardando_humano';
  const motivoEscalada = tk?.motivoEscalonamento ?? 'assunto sensível';

  const inicioTurno = Date.now();
  // #30: tokens de TODA chamada do turno (classificador + resumo) entram no
  // trace e no evento_llm — o custo do /metricas deixa de subcontar
  const usageExtra = { entrada: 0, saida: 0 };
  const fusao: { resultado: FusaoResultado; textoEnviado: string | null } = {
    resultado: 'enviado',
    textoEnviado: null,
  };
  const enviar = async (texto: string, opts: { ignorarPendentes?: boolean } = {}) => {
    fusao.resultado = await enfileirarComFusao(deps, t, [texto], opts);
    fusao.textoEnviado = fusao.resultado === 'enviado' ? texto : null;
  };
  // 014: N mensagens do fluxo de cobrança num turno só
  const enviarVarias = async (textos: readonly string[], seqInicial = 1) => {
    if (textos.length === 0) return;
    fusao.resultado = await enfileirarComFusao(deps, t, textos, {
      seqInicial,
      ignorarPendentes: seqInicial > 1,
    });
    fusao.textoEnviado = fusao.resultado === 'enviado' ? textos.join('\n\n') : null;
  };

  // 014: agente de cobrança — só com o módulo ligado, vínculo e deps presentes
  const pagamentos =
    deps.clientConfig.modulos.pagamentos && deps.pagamentos && clienteId !== ''
      ? deps.pagamentos
      : null;
  const fluxoDeps: FluxoDeps | null = pagamentos
    ? {
        db: deps.db,
        boss: deps.boss,
        executor: deps.executor,
        repo: pagamentos.repo,
        provider: deps.provider,
        psp: pagamentos.psp,
        env: pagamentos.env,
        logger: deps.logger,
      }
    : null;
  const ctxFluxo = {
    conversaId: t.conversaId,
    turnoId: t.id,
    session,
    textoUsuario: t.textoAgregado,
  };
  // 015: agente SDR — só na raia SEM vínculo, com o módulo ligado e deps presentes.
  // As duas raias são disjuntas por construção: o SDR não toca o fluxo do cotista.
  const sdrDeps: SdrFluxoDeps | null =
    deps.clientConfig.modulos.sdr && deps.sdr && clienteId === ''
      ? {
          db: deps.db,
          executor: deps.executor,
          repo: deps.sdr.repo,
          provider: deps.provider,
          env: deps.sdr.env,
          logger: deps.logger,
        }
      : null;
  const ctxSdr = {
    conversaId: t.conversaId,
    turnoId: t.id,
    waId: conv.waId,
    session,
    textoUsuario: t.textoAgregado,
  };
  const resultadoDoFluxo = (
    r: Pick<
      ResultadoFluxo,
      'mensagens' | 'escalado' | 'escaladoTrigger' | 'eventos' | 'tokensEntrada' | 'tokensSaida'
    >,
  ): ResultadoComFusao => ({
    resposta: r.mensagens.join('\n\n'),
    escalado: r.escalado,
    escaladoTrigger: r.escaladoTrigger,
    fallback: false,
    fallbackMotivo: null,
    eventos: [...r.eventos, ...(r.escalado ? [{ tipo: 'escalado' as const }] : [])],
    tokensEntrada: usageExtra.entrada + r.tokensEntrada,
    tokensSaida: usageExtra.saida + r.tokensSaida,
    latenciaMs: Date.now() - inicioTurno,
    fusao: fusao.resultado,
    respostaEnviada: fusao.textoEnviado,
  });
  let personaExtra = '';
  if (fluxoDeps) {
    const ativo = await fluxoDeps.repo.fluxoAtivo(t.conversaId);
    if (ativo) {
      const r = await continuarFluxo(fluxoDeps, ativo, ctxFluxo);
      if (!r.abandonado) {
        await enviarVarias(r.mensagens);
        return resultadoDoFluxo(r);
      }
      // saiu da frente: o agente geral responde este turno sabendo do contexto
      personaExtra = NOTA_FLUXO_ABANDONADO;
    }
  }
  // 015: fluxo SDR ativo consome o turno do lead (mesma forma da cobrança)
  if (sdrDeps) {
    const ativo = await sdrDeps.repo.fluxoAtivo(t.conversaId);
    if (ativo) {
      const r = await continuarFluxoSdr(sdrDeps, ativo, ctxSdr);
      if (!r.abandonado) {
        await enviarVarias(r.mensagens);
        return resultadoDoFluxo(r);
      }
      personaExtra = NOTA_FLUXO_SDR_ABANDONADO;
    }
  }
  const efeitos = {
    gravarResposta: async (texto: string, meta?: { escalado: boolean; fallback: boolean }) => {
      // #46/#47: escalada não é silenciada por pendência (o contato precisa
      // saber do humano), mas com a conversa JÁ na fila a mensagem de
      // transição não se repete — vira o reconhecimento da fila
      if (meta?.escalado) {
        await enviar(filaHumano && texto === TEXTO_TRANSICAO ? TEXTO_JA_NA_FILA : texto, {
          ignorarPendentes: true,
        });
        return;
      }
      await enviar(texto);
    },
    atualizarResumoSePreciso: async () => {
      const uso = await atualizarResumo(deps, conv.id, traceId);
      usageExtra.entrada += uso.tokensEntrada;
      usageExtra.saida += uso.tokensSaida;
    },
  };

  if (!deps.provider) {
    await efeitos.gravarResposta(TEXTO_FALLBACK);
    return {
      resposta: TEXTO_FALLBACK,
      escalado: false,
      escaladoTrigger: null,
      fallback: true,
      fallbackMotivo: 'LLM não configurado (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL)',
      eventos: [{ tipo: 'fallback', motivo: 'LLM não configurado' }],
      tokensEntrada: 0,
      tokensSaida: 0,
      latenciaMs: 0,
      fusao: fusao.resultado,
      respostaEnviada: fusao.textoEnviado,
    };
  }

  // guardrail de intenção (006): classificação curta ANTES de o agente responder
  const cls = await classificarIntencao(
    deps.provider,
    t.textoAgregado,
    deps.clientConfig.guardrails.temasSensiveis,
    { traceId }, // 016
  ).catch(() => ({ intencao: 'outro' as const, tokensEntrada: 0, tokensSaida: 0 }));
  const intencao = cls.intencao;
  usageExtra.entrada += cls.tokensEntrada;
  usageExtra.saida += cls.tokensSaida;
  // 014: "quero pagar" inicia o agente de cobrança em vez de escalar
  if (intencao === 'pagar' && fluxoDeps) {
    const r = await iniciarFluxo(fluxoDeps, ctxFluxo);
    await enviarVarias(r.mensagens);
    return resultadoDoFluxo(r);
  }
  // 015: interesse de compra SEM vínculo inicia o SDR em vez de escalar; com
  // vínculo (cotista querendo outra cota) segue escalando `interesse_compra`
  if (intencao === 'comprar_cota' && sdrDeps) {
    const r = await iniciarFluxoSdr(sdrDeps, ctxSdr);
    await enviarVarias(r.mensagens);
    return resultadoDoFluxo(r);
  }
  if (intencaoEscala(intencao)) {
    const trigger = TRIGGER_POR_INTENCAO[intencao];
    // 014: interesse em cota nova vai para o comercial com texto próprio
    const textoTransicao = intencao === 'comprar_cota' ? TEXTO_INTERESSE_COMPRA : TEXTO_TRANSICAO;
    // #47: já na fila ⇒ o tema segue proibido (006), mas a escalada não se
    // repete — o contato ouve que o assunto já está com um atendente
    if (filaHumano) {
      await enviar(TEXTO_JA_NA_FILA);
      return {
        resposta: TEXTO_JA_NA_FILA,
        escalado: false,
        escaladoTrigger: null,
        fallback: false,
        fallbackMotivo: null,
        eventos: [
          {
            tipo: 'verdict',
            guardrail: 'classificador_intencao',
            hook: 'beforeReply',
            verdict: {
              tipo: 'escalate',
              trigger,
              reason: `intenção ${intencao} com a conversa já na fila — reconhecimento sem nova escalada`,
            },
          },
        ],
        tokensEntrada: usageExtra.entrada,
        tokensSaida: usageExtra.saida,
        latenciaMs: Date.now() - inicioTurno,
        fusao: fusao.resultado,
        respostaEnviada: fusao.textoEnviado,
      };
    }
    await efeitos.gravarResposta(textoTransicao, { escalado: true, fallback: false });
    return {
      resposta: textoTransicao,
      escalado: true,
      escaladoTrigger: trigger,
      fallback: false,
      fallbackMotivo: null,
      eventos: [
        {
          tipo: 'verdict',
          guardrail: 'classificador_intencao',
          hook: 'beforeReply',
          verdict: { tipo: 'escalate', trigger, reason: `intenção classificada: ${intencao}` },
        },
        { tipo: 'escalado' },
      ],
      tokensEntrada: usageExtra.entrada,
      tokensSaida: usageExtra.saida,
      latenciaMs: Date.now() - inicioTurno, // latência REAL — 0 distorcia o p95
      fusao: fusao.resultado,
      respostaEnviada: fusao.textoEnviado,
    };
  }

  // as N mais RECENTES, em ordem cronológica; turno_id IS NULL (mensagem manual
  // do atendente) também entra — ne() sozinho descartaria essas linhas (NULL <> x)
  const historicoDb = await deps.db
    .select()
    .from(mensagem)
    .where(
      and(
        eq(mensagem.conversaId, conv.id),
        or(isNull(mensagem.turnoId), ne(mensagem.turnoId, t.id)),
      ),
    )
    .orderBy(desc(mensagem.criadoEm))
    .limit(deps.clientConfig.limites.maxMensagensContexto);
  historicoDb.reverse();
  const historico: ChatMessage[] = historicoDb.map((m) => ({
    role: m.direcao === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.texto,
  }));

  const provider = deps.provider;
  const tools = [
    ...buildToolSpecs(deps.catalog, deps.executor, {
      modulosHabilitados: deps.clientConfig.modulos,
      temVinculo: clienteId !== '', // #35: sem vínculo, tools de dado nem aparecem
    }),
    toolBuscarConhecimento({
      store: deps.store,
      embed: (texto) => provider.embed([texto]).then((v) => Array.from(v[0] ?? [])),
    }),
    toolEscalarParaHumano(),
    // 014: o agente geral pode entregar ao fluxo de cobrança e reler a última cobrança
    ...(pagamentos ? [toolIniciarPagamento(), toolCobrancaEmAberto(pagamentos.repo)] : []),
  ];

  // skills top-2 no contexto (009); ids entram no trace p/ atribuição de uso
  let skills: { id: string; conteudo: string }[] = [];
  if (deps.registry) {
    const embedding = await deps.provider
      .embed([t.textoAgregado])
      .then((v) => Array.from(v[0] ?? []))
      .catch(() => undefined);
    const ativas = await deps.registry
      .activeFor({ texto: t.textoAgregado, ...(embedding?.length ? { embedding } : {}) }, 2)
      .catch((err) => {
        deps.logger.warn({ err }, 'retrieval de skills falhou — turno segue sem skills (#32)');
        return [];
      });
    skills = ativas.map((sk) => ({
      id: sk.skillId,
      conteudo: `## ${sk.idLogico} (v${sk.versao})\n${sk.doc.corpo}`,
    }));
  }

  // #47: com a conversa na fila, o agente sabe que o humano já foi acionado —
  // atende outros assuntos e não promete (nem escala) de novo o mesmo tema
  // 015: na raia do lead frio a persona é a comercial (personaSdr), se houver
  const personaBase = sdrDeps
    ? (deps.clientConfig.personaSdr ?? deps.clientConfig.persona)
    : deps.clientConfig.persona;
  const persona =
    (filaHumano
      ? `${personaBase}\n\nATENÇÃO: um atendente humano JÁ FOI ACIONADO para esta ` +
        `conversa (motivo: ${motivoEscalada}) e ela está na fila de atendimento. Sobre ESSE ` +
        'assunto, apenas informe que um atendente vai assumir em instantes — não responda o ' +
        'tema, não prometa acionar de novo e não use a tool escalar_para_humano para o mesmo ' +
        'motivo. Continue ajudando normalmente em qualquer outro assunto.'
      : personaBase) + personaExtra;

  const runtime = createAgentRuntime({
    provider: deps.provider,
    guardrails: [guardrailPreco()],
  });
  const resultado = await runtime.processarTurno({
    session,
    persona,
    resumo: conv.resumo,
    skills,
    historico,
    textoUsuario: t.textoAgregado,
    tools,
    limites: {
      maxToolCalls: deps.clientConfig.limites.maxToolCallsPorTurno,
      timeoutMs: deps.turnoTimeoutMs,
      retriesPorTool: 1,
    },
    efeitos,
  });

  // 014: o agente entregou ao fluxo de cobrança (tool iniciar_pagamento) — a
  // listagem sai como seq 2..n do MESMO turno, logo após a frase do agente.
  // Só se a frase do agente realmente saiu (turno fundido/descartado ⇒ nada).
  let fluxoIniciado: ResultadoFluxo | null = null;
  const textoAgente = fusao.textoEnviado;
  if (resultado.fluxoPagamentoSolicitado && fluxoDeps && fusao.resultado === 'enviado') {
    fluxoIniciado = await iniciarFluxo(fluxoDeps, ctxFluxo);
    await enviarVarias(fluxoIniciado.mensagens, 2);
  }
  const escalado = (resultado.escalado || fluxoIniciado?.escalado === true) && !filaHumano;
  return {
    ...resultado,
    // #47: escalada com a conversa JÁ na fila não é nova escalada — o ticket
    // não muda e a métrica de escalonamento não conta duas vezes
    escalado,
    escaladoTrigger: filaHumano
      ? null
      : (resultado.escaladoTrigger ?? fluxoIniciado?.escaladoTrigger ?? null),
    eventos: [...resultado.eventos, ...(fluxoIniciado?.eventos ?? [])],
    tokensEntrada: resultado.tokensEntrada + usageExtra.entrada,
    tokensSaida: resultado.tokensSaida + usageExtra.saida,
    fusao: fusao.resultado,
    respostaEnviada: fluxoIniciado
      ? [textoAgente, ...fluxoIniciado.mensagens].filter((s) => s).join('\n\n')
      : fusao.textoEnviado,
  };
}

/** Escalada do bot (007): ticket → aguardando_humano com o motivo da tool. */
async function ticketIdDe(db: Db, t: TurnoPronto): Promise<string | null> {
  const [tk] = await db
    .select({ id: ticket.id })
    .from(ticket)
    .where(eq(ticket.conversaId, t.conversaId))
    .limit(1);
  return tk?.id ?? null;
}

/**
 * Emissão da 010 (fire-and-forget dentro do emitter): 1 evento_llm por turno
 * com o usage agregado, 1 evento_guardrail por verdict e 1 evento_escalonamento
 * quando o turno escala — todos com traceId e ticketId (quando existe).
 */
function emitirObservabilidade(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  traceId: string,
  resultado: ResultadoTurno,
  ticketId: string | null,
): void {
  const base = { traceId, conversaId: t.conversaId, turnoId: t.id, ticketId };

  if (deps.provider) {
    deps.obs.llm({
      ...base,
      modelo: deps.provider.modelId,
      tokensEntrada: resultado.tokensEntrada,
      tokensSaida: resultado.tokensSaida,
      latenciaMs: resultado.latenciaMs,
    });
  }

  const verdicts = resultado.eventos.filter((e) => e.tipo === 'verdict');
  for (const v of verdicts) {
    const hook = v.hook === 'beforeTool' || v.hook === 'afterTool' ? v.hook : 'beforeReply';
    deps.obs.guardrail({
      ...base,
      guardrail: v.guardrail,
      hook,
      verdict: v.verdict.tipo,
      motivo:
        v.verdict.tipo === 'block' || v.verdict.tipo === 'escalate'
          ? (v.verdict.reason ?? null)
          : null,
    });
  }

  if (resultado.escalado) {
    const escalate = verdicts.find((v) => v.verdict.tipo === 'escalate');
    const origem = escalate
      ? escalate.guardrail === 'classificador_intencao'
        ? 'intencao'
        : 'guardrail'
      : resultado.fallbackMotivo?.includes('falhas de tool')
        ? 'falha_tool'
        : 'agente';
    deps.obs.escalonamento({
      ...base,
      motivo: resultado.escaladoTrigger ?? 'pedido_do_agente',
      origem,
    });
  }
}

async function escalarTicket(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  resultado: ResultadoTurno,
): Promise<void> {
  const atual = await garantirTicket(deps.db, t.conversaId);
  if (atual.status !== 'bot_ativo') return; // já escalado/atendido — nada a fazer
  const evTool = resultado.eventos.find(
    (e) => e.tipo === 'tool' && e.nome === 'escalar_para_humano',
  );
  const motivoTool =
    evTool?.tipo === 'tool' && typeof evTool.params.motivo === 'string'
      ? evTool.params.motivo
      : null;
  // motivo textual da tool > trigger do guardrail > motivo do fallback
  const motivo =
    motivoTool ?? resultado.escaladoTrigger ?? resultado.fallbackMotivo ?? 'escalado pelo agente';
  await aplicarTransicao(deps.db, atual, 'aguardando_humano', 'bot', { motivo });
  // escalonamento também é sinal de aprendizado (009)
  await deps.db.insert(sinalAprendizado).values({
    id: newTraceId(),
    tipo: 'escalonamento',
    ticketId: atual.id,
    conversaId: t.conversaId,
    payload: {
      refId: t.id,
      motivo,
      trigger: resultado.escaladoTrigger,
      textoUsuario: t.textoAgregado,
    },
  });
}

/** 006: todo verdict != allow do turno vira sinal_aprendizado (a 009 consome). */
async function gravarSinaisDeVerdict(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  resultado: ResultadoTurno,
): Promise<void> {
  const verdicts = resultado.eventos.filter((e) => e.tipo === 'verdict');
  for (const v of verdicts) {
    if (v.tipo !== 'verdict') continue;
    await deps.db.insert(sinalAprendizado).values({
      id: newTraceId(),
      tipo: 'verdict_guardrail',
      conversaId: t.conversaId,
      payload: {
        guardrail: v.guardrail,
        hook: v.hook,
        verdict: v.verdict,
        textoUsuario: t.textoAgregado,
        resposta: resultado.resposta,
        turnoId: t.id,
      },
    });
  }
}

/** Sumarização barata a cada K turnos (uma chamada curta ao provider). */
const SEM_USO = { tokensEntrada: 0, tokensSaida: 0 } as const;
const TIMEOUT_RESUMO_MS = 20_000;

async function atualizarResumo(
  deps: AgentTurnoHandlerDeps,
  conversaId: string,
  traceId: string,
): Promise<{ tokensEntrada: number; tokensSaida: number }> {
  const [conv] = await deps.db
    .update(conversa)
    .set({ turnosDesdeResumo: sql`${conversa.turnosDesdeResumo} + 1` })
    .where(eq(conversa.id, conversaId))
    .returning();
  if (!conv || !deps.provider || conv.turnosDesdeResumo < deps.resumoACadaTurnos) return SEM_USO;

  const ultimas = await deps.db
    .select()
    .from(mensagem)
    .where(eq(mensagem.conversaId, conversaId))
    .orderBy(desc(mensagem.criadoEm)) // as mais recentes — senão o resumo nunca avança
    .limit(deps.clientConfig.limites.maxMensagensContexto);
  ultimas.reverse();
  const transcricao = ultimas
    .map((m) => `${m.direcao === 'in' ? 'Cliente' : 'Agente'}: ${m.texto}`)
    .join('\n');

  try {
    const res = await deps.provider.chat({
      signal: AbortSignal.timeout(TIMEOUT_RESUMO_MS), // pendurado não segura o turno (#27)
      traceId, // 016
      messages: [
        {
          role: 'system',
          content:
            'Resuma a conversa a seguir em até 5 linhas, em português, guardando fatos úteis ' +
            'para o atendimento continuar (pedidos citados, boletos, pendências, tom do cliente).',
        },
        {
          role: 'user',
          content: `Resumo anterior:\n${conv.resumo ?? '(nenhum)'}\n\n${transcricao}`,
        },
      ],
      maxOutputTokens: 300,
    });
    if (res.content) {
      await deps.db
        .update(conversa)
        .set({ resumo: res.content, turnosDesdeResumo: 0 })
        .where(eq(conversa.id, conversaId));
    }
    return { tokensEntrada: res.tokensEntrada, tokensSaida: res.tokensSaida };
  } catch (err) {
    deps.logger.warn({ err, conversaId }, 'sumarização do resumo falhou — segue sem atualizar');
    return SEM_USO;
  }
}

async function gravarTrace(
  db: Db,
  t: TurnoPronto,
  traceId: string,
  r: ResultadoTurno,
): Promise<void> {
  // turnos sem nó de contexto (ex.: escalada pelo classificador) gravam {}
  const contexto = r.eventos.find((e) => e.tipo === 'contexto') ?? {};
  await db.insert(traceTurno).values({
    id: newTraceId(),
    turnoId: t.id,
    conversaId: t.conversaId,
    traceId,
    contexto,
    eventos: r.eventos,
    resposta: r.resposta,
    escalado: r.escalado,
    fallback: r.fallback,
    fallbackMotivo: r.fallbackMotivo,
    tokensEntrada: r.tokensEntrada,
    tokensSaida: r.tokensSaida,
    latenciaMs: r.latenciaMs,
  });
}
