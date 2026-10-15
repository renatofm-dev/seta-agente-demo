import {
  createAgentRuntime,
  type ResultadoTurno,
  TEXTO_FALLBACK,
  TEXTO_TRANSICAO,
  type TraceEvento,
  toolEscalarParaHumano,
  toolIniciarPagamento,
  toolIniciarReserva,
} from '@seta/agent';
import type { AIProvider, ChatMessage } from '@seta/ai-provider';
import type { ClientConfig } from '@seta/client-config';
import { TEXTO_INTERESSE_COMPRA } from '@seta/cobranca';
import type { ErpWriter } from '@seta/erp-api-tse';
import {
  classificarIntencao,
  guardrailPercentualSdr,
  guardrailPreco,
  intencaoEscala,
  TRIGGER_POR_INTENCAO,
} from '@seta/guardrails';
import { newTraceId, type ObsEmitter } from '@seta/observability';
import type { PaymentProvider } from '@seta/payment-provider';
import { buildToolSpecs, type CatalogIndex, type Executor } from '@seta/query-catalog';
import type { VectorStore } from '@seta/rag';
import type { SkillRegistry } from '@seta/skills';
import type { IndicadorDigitacao } from '@seta/wa-meta';
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
  continuarFluxo as continuarFluxoReserva,
  type EnvFluxoReserva,
  iniciarFluxo as iniciarFluxoReserva,
  type ReservaFluxoDeps,
  type ResultadoFluxoReserva,
} from '../reserva/fluxo.js';
import type { ReservaRepo } from '../reserva/repo.js';
import { toolHoteisDisponiveis, toolMinhasReservas } from '../reserva/tools.js';
import {
  continuarFluxoSdr,
  type EnvSdr,
  iniciarFluxoSdr,
  type SdrFluxoDeps,
} from '../sdr/fluxo.js';
import type { SdrRepo } from '../sdr/repo.js';
import type { VendaRepo } from '../venda/repo.js';
import type { TurnoHandler, TurnoPronto } from './debounce.js';
import { agendarDebounce } from './inbound.js';
import {
  type AnexoDaLinha,
  enqueueOutbound,
  enviarJobOutbound,
  inserirOutbound,
  type ResolvedorAnexo,
} from './outbox.js';
import { type PedidoSegundaVia, toolEnviarSegundaVia } from './segunda-via.js';
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
  /**
   * 040: quem busca o boleto no ERP. Ausente ⇒ a tool de 2ª via nem aparece
   * para o modelo — melhor não oferecer do que oferecer e falhar na entrega.
   */
  readonly anexos?: ResolvedorAnexo;
  /** 016: acumulador do decorator de anonimização — drenado para o trace do turno. */
  readonly anonimizacao?: { consumir(traceId: string): TraceEvento | null };
  /** 015: agente SDR da raia sem vínculo; ausente ⇒ lead frio escala como antes. */
  readonly sdr?: SdrTurnoDeps;
  /** 038: reserva de utilização; ausente ⇒ o agente não sabe reservar. */
  readonly reserva?: ReservaTurnoDeps;
  /** 045: presente ⇒ o SDR fecha a venda com sinal por PIX. */
  readonly venda?: VendaTurnoDeps;
  /**
   * Quem mostra "digitando…" no WhatsApp. Ausente ⇒ turno igual ao de antes.
   *
   * NÃO é o `OutboundGateway`: o handler só enfileira no outbox, e receber o
   * gateway inteiro aqui abriria a porta para furar essa invariante — é por não
   * ter o gateway na mão que ele não pode enviar por fora.
   */
  readonly digitacao?: IndicadorDigitacao;
  /**
   * Atraso do primeiro disparo do indicador. Existe como dep, e não só como
   * constante, para o teste afirmar a INVARIANTE ("turno que termina antes do
   * atraso não acende nada") em vez de depender de o turno cair fora de uma
   * faixa de milissegundos. Ausente ⇒ `ATRASO_INICIAL_DIGITACAO_MS`.
   */
  readonly digitacaoAtrasoMs?: number;
}

/** 045: o que o fechamento da venda precisa além do que o turno já tem. */
export interface VendaTurnoDeps {
  readonly repo: VendaRepo;
  readonly pspNome: string;
}

/** 038: o que o fluxo de reserva precisa além do que o turno já tem. */
export interface ReservaTurnoDeps {
  readonly repo: ReservaRepo;
  readonly writer: ErpWriter;
  readonly env: EnvFluxoReserva;
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
/**
 * 040: o turno pode sair com um DOCUMENTO no meio das mensagens. A saída deixa
 * de ser só texto, e uma string continua valendo como atalho para "texto puro".
 */
type SaidaDoTurno = string | { readonly texto: string; readonly anexo: AnexoDaLinha };

const comoSaida = (s: SaidaDoTurno): { texto: string; anexo?: AnexoDaLinha } =>
  typeof s === 'string' ? { texto: s } : { texto: s.texto, anexo: s.anexo };

async function enfileirarComFusao(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  textos: readonly SaidaDoTurno[],
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
    for (const [i, saida] of textos.entries()) {
      const { texto, anexo } = comoSaida(saida);
      const base = { conversaId: t.conversaId, turnoId: t.id, seq: seqInicial + i, texto };
      const inserido = await inserirOutbound(tx, anexo ? { ...base, anexo } : base);
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

/**
 * 25 s é o teto da Meta para o indicador; renovar a 20 s deixa folga de rede
 * para o próximo chegar antes de o anterior apagar.
 */
const RENOVAR_DIGITACAO_MS = 20_000;
/**
 * Atraso do PRIMEIRO disparo. Turno que responde sem LLM — opt-out (044),
 * `TEXTO_JA_NA_FILA` (#47), e todo turno em dev sem `LLM_*` — termina em dezenas
 * de ms. Acender o indicador ali faria o request pousar na Meta DEPOIS de a
 * resposta ter saído, e aí não há mais o que o apague: o contato pediria para
 * sair da lista, receberia a confirmação e veria o robô "digitando" por 25 s.
 * Com o atraso, esses turnos não acendem NADA, de forma determinística, em vez de
 * depender de quem ganha a corrida. Em turno de LLM 250 ms é imperceptível: o
 * contato já esperou o debounce inteiro.
 *
 * CONSEQUÊNCIA DELIBERADA: como o indicador e o read receipt são o MESMO request,
 * não acender nada também significa não marcar a mensagem como lida. Quem pede
 * para sair da lista recebe a confirmação sem os dois tiques azuis. É a troca
 * certa: a própria resposta é o reconhecimento, e ela chega em menos de um
 * segundo — melhor do que um "digitando" fantasma por 25 s depois dela.
 */
const ATRASO_INICIAL_DIGITACAO_MS = 250;
/**
 * Teto de renovações: 3 cobrem ~80 s, além do `AGENT_TURN_TIMEOUT_MS` (60 s). O
 * teto existe para o timer nunca ser eterno se o `parar()` não chegar por um
 * caminho que ninguém previu.
 */
const MAX_RENOVACOES_DIGITACAO = 3;

interface Digitacao {
  /** Idempotente: é chamado do enfileiramento E do `finally` do turno. */
  parar(): void;
}

/** Turno sem indicador configurado ou sem wamid: nada a mostrar, nada a parar. */
const SEM_DIGITACAO: Digitacao = { parar: () => {} };

/**
 * Mostra "digitando…" e vai RENOVANDO enquanto o turno roda (a Meta apaga o
 * indicador em 25 s). Best-effort de verdade: sem wamid, sem indicador
 * configurado, 400 da Meta ou rede fora ⇒ log e segue. Nunca entra no caminho
 * crítico da resposta (nem com o timeout de 3 s do adapter) e nunca faz o job do
 * turno re-tentar — o `.catch` em cada disparo é o que garante que uma promise
 * rejeitada solta não vire unhandled rejection.
 *
 * `setTimeout` em cadeia, e não `setInterval`: um handle por vez, sem chance de
 * dois disparos se sobreporem. `unref()` para o indicador nunca segurar o
 * encerramento do processo (nem o teardown da suíte de testes).
 *
 * O efeito marca a mensagem como LIDA — é o mesmo request na Cloud API, não há
 * como ter um sem o outro. Por isso o chamador é UM só, e é o ponto onde
 * responder já é decisão tomada.
 */
function mostrarDigitando(deps: AgentTurnoHandlerDeps, t: TurnoPronto, traceId: string): Digitacao {
  const indicador = deps.digitacao;
  const wamid = t.waMessageIdUltima;
  if (!indicador || !wamid) return SEM_DIGITACAO;

  let restantes = MAX_RENOVACOES_DIGITACAO;
  let timer: NodeJS.Timeout | null = null;
  // cancela o disparo EM VÔO, não só os futuros: o timer morto não impede um
  // request que já saiu de pousar depois da resposta
  const abortar = new AbortController();
  const agendar = (atrasoMs: number): void => {
    timer = setTimeout(disparar, atrasoMs);
    timer.unref(); // o indicador nunca segura o encerramento do processo
  };
  const disparar = (): void => {
    void indicador.mostrar(wamid, abortar.signal).catch((err) => {
      if (abortar.signal.aborted) return; // cancelado por nós: não é falha
      deps.logger.warn(
        { err, turnoId: t.id, traceId },
        'indicador de digitação falhou — turno segue normal',
      );
    });
    if (restantes <= 0) return;
    restantes -= 1;
    agendar(RENOVAR_DIGITACAO_MS);
  };
  agendar(deps.digitacaoAtrasoMs ?? ATRASO_INICIAL_DIGITACAO_MS);

  return {
    parar() {
      if (timer) clearTimeout(timer);
      timer = null;
      restantes = 0;
      abortar.abort();
    },
  };
}

export function createAgentTurnoHandler(deps: AgentTurnoHandlerDeps): TurnoHandler {
  return {
    async processar(t: TurnoPronto): Promise<void> {
      const traceId = newTraceId();
      const inicio = Date.now();
      /**
       * Aqui — e não no webhook — é onde "o agente vai responder" é verdade: o
       * debounce já fechou (ele come 6 a 15 s dos 25 s do indicador) e o
       * ticketGate já deixou passar (ticket `humano_ativo` nem cria turno, então
       * bot silenciado nunca aparece digitando). Antes do trabalho do modelo,
       * que é justamente o tempo que a feature existe para cobrir.
       */
      const digitacao = mostrarDigitando(deps, t, traceId);
      try {
        const resultado = await processarComAgente(deps, t, traceId, digitacao);
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
      } finally {
        // rede de segurança: nenhum timer sobrevive ao turno, nem no caminho de
        // exceção. O ponto normal de parada é o enfileiramento da resposta.
        digitacao.parar();
      }
    },
  };
}

async function processarComAgente(
  deps: AgentTurnoHandlerDeps,
  t: TurnoPronto,
  traceId: string,
  digitacao: Digitacao,
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
  /**
   * O `parar()` vem ANTES do enfileiramento, e não só no `finally` de `processar`:
   * entre o enqueue e o `finally` ainda rodam `escalarTicket`,
   * `gravarSinaisDeVerdict`, `emitirObservabilidade` e `gravarTrace` — dezenas de
   * ms com ida ao banco. Uma renovação caindo nessa janela acenderia "digitando"
   * com a resposta já a caminho, e ele ficaria aceso por 25 s.
   */
  const enviar = async (texto: string, opts: { ignorarPendentes?: boolean } = {}) => {
    digitacao.parar();
    fusao.resultado = await enfileirarComFusao(deps, t, [texto], opts);
    fusao.textoEnviado = fusao.resultado === 'enviado' ? texto : null;
  };
  // 014: N mensagens do fluxo de cobrança num turno só
  const enviarVarias = async (textos: readonly SaidaDoTurno[], seqInicial = 1) => {
    if (textos.length === 0) return;
    digitacao.parar();
    fusao.resultado = await enfileirarComFusao(deps, t, textos, {
      seqInicial,
      ignorarPendentes: seqInicial > 1,
    });
    fusao.textoEnviado =
      fusao.resultado === 'enviado' ? textos.map((x) => comoSaida(x).texto).join('\n\n') : null;
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
  /**
   * 015 + 045: o agente SDR.
   *
   * A 015 rodava só na raia SEM vínculo. A 045 abre para o cotista também —
   * quem já tem contrato pode comprar outra cota, e antes disso a conversa
   * escalava para o comercial. O que muda por raia é só QUEM é o comprador:
   *
   *  - sem vínculo: lead frio, o CPF é pedido na etapa `dados`;
   *  - com vínculo: nome e CPF vêm de `contato` e a etapa `dados` é pulada —
   *    o CPF do cotista não volta a trafegar pela conversa.
   *
   * Sem `deps.venda` o fluxo não fecha venda nenhuma: o aceite continua caindo
   * em `agendamento`, que é o comportamento da 015a.
   */
  const compradorConhecido =
    clienteId !== '' && vinculo?.documento
      ? { nome: vinculo.nome ?? 'Cotista', cpf: vinculo.documento }
      : null;
  const sdrDeps: SdrFluxoDeps | null =
    deps.clientConfig.modulos.sdr && deps.sdr
      ? {
          db: deps.db,
          executor: deps.executor,
          repo: deps.sdr.repo,
          provider: deps.provider,
          env: deps.sdr.env,
          logger: deps.logger,
          venda: deps.venda
            ? {
                repo: deps.venda.repo,
                boss: deps.boss,
                pspNome: deps.venda.pspNome,
                compradorConhecido,
              }
            : null,
        }
      : null;
  /**
   * 038: reserva vive na MESMA raia do pagamento (cotista com vínculo) — é a
   * primeira fatia a dividir raia com outro fluxo. A precedência está no bloco
   * de "fluxo ativo" abaixo: pagamento primeiro, porque tem dinheiro em jogo.
   */
  const reservaDeps: ReservaFluxoDeps | null =
    deps.clientConfig.modulos.reserva && deps.reserva && pagamentos && clienteId !== ''
      ? {
          db: deps.db,
          boss: deps.boss,
          executor: deps.executor,
          repo: deps.reserva.repo,
          pagamentos: pagamentos.repo,
          writer: deps.reserva.writer,
          provider: deps.provider,
          env: deps.reserva.env,
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
  /** 038: o fluxo de reserva não emite eventos de trace próprios (ainda). */
  const resultadoDoFluxoReserva = (r: ResultadoFluxoReserva): ResultadoComFusao =>
    resultadoDoFluxo({ ...r, eventos: [] });

  // 038: reserva ativa consome o turno (mesma forma da cobrança). Vem DEPOIS do
  // fluxo de pagamento de propósito: os dois vivem na raia do cotista, e quem
  // tem dinheiro em jogo fala primeiro.
  if (reservaDeps) {
    const ativo = await reservaDeps.repo.fluxoAtivo(t.conversaId);
    if (ativo) {
      const r = await continuarFluxoReserva(reservaDeps, ativo, ctxFluxo);
      if (!r.abandonado) {
        await enviarVarias(r.mensagens);
        return resultadoDoFluxoReserva(r);
      }
      personaExtra = NOTA_FLUXO_ABANDONADO;
    }
  }
  /**
   * 015: fluxo SDR ativo consome o turno (mesma forma da cobrança).
   *
   * 045: com a raia do cotista aberta, TRÊS fluxos passam a dividir a mesma
   * raia. A precedência é a ordem destes blocos e é deliberada:
   *
   *   pagamento → reserva → venda
   *
   * Dinheiro que o cliente JÁ DEVE fala primeiro; depois o uso do que ele já
   * comprou; por último a compra nova. Um cotista no meio de uma compra que
   * peça para pagar uma parcela é atendido pelo fluxo de venda até sair dele —
   * na etapa `fechamento` isso é de propósito, porque há uma cobrança emitida
   * esperando pagamento e trocar de assunto perderia o contexto dela.
   */
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
  /**
   * 038: "quero reservar" inicia o fluxo de reserva. Sem este ramo o
   * classificador não tinha categoria para reserva e a frase mais natural do
   * cotista ("gostaria de realizar uma reserva") caía em `comprar_cota` — o
   * turno escalava para o comercial e o fluxo da 038 nunca começava.
   *
   * Sem vínculo não existe contrato para usar: ali a mesma frase é interesse
   * comercial e segue para o SDR. A raia resolve a ambiguidade de "reservar".
   */
  if (intencao === 'reservar') {
    if (reservaDeps) {
      const r = await iniciarFluxoReserva(reservaDeps, ctxFluxo);
      await enviarVarias(r.mensagens);
      return resultadoDoFluxoReserva(r);
    }
    if (sdrDeps) {
      const r = await iniciarFluxoSdr(sdrDeps, ctxSdr);
      await enviarVarias(r.mensagens);
      return resultadoDoFluxo(r);
    }
    // sem os dois (módulo desligado) o agente geral responde este turno
  }
  // 015/045: interesse de compra inicia o SDR nas DUAS raias. Antes da 045, o
  // cotista com vínculo escalava para o comercial aqui.
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
  /**
   * 040: a tool não envia o boleto — ela anota aqui o que verificou, e o
   * servidor entrega depois da frase do agente. Mutável de propósito, como o
   * `fusao` acima: é o canal de volta de um efeito que acontece FORA do turno
   * do modelo, e o PDF nunca chega perto do prompt.
   *
   * Só na raia do cotista com módulo financeiro: sem vínculo não há contrato
   * de sessão para validar o `titulo_id` contra, e a tool não existiria com
   * segurança.
   */
  const pedidosSegundaVia: PedidoSegundaVia[] = [];
  const segundaViaDisponivel =
    deps.clientConfig.modulos.financeiro && clienteId !== '' && deps.anexos !== undefined;

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
    ...(reservaDeps
      ? [
          toolIniciarReserva(),
          toolHoteisDisponiveis(reservaDeps.writer),
          toolMinhasReservas(reservaDeps.repo),
        ]
      : []),
    // 040: 2ª via de boleto em PDF
    ...(segundaViaDisponivel
      ? [
          toolEnviarSegundaVia({ executor: deps.executor, session }, (p) =>
            pedidosSegundaVia.push(p),
          ),
        ]
      : []),
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

  /**
   * Quem está na raia COMERCIAL é quem não tem vínculo — e a conta é `clienteId
   * === ''`, não `sdrDeps !== null`.
   *
   * A 015 ligava o SDR só para lead frio, e ali `sdrDeps` e "sem vínculo" eram
   * a mesma coisa. A 045 abriu o fluxo de venda para o cotista também (ele pode
   * comprar outra cota), então `sdrDeps` passou a existir para TODO MUNDO — e
   * esta linha, que não mudou, passou a dar a persona comercial ao cotista.
   *
   * O efeito (#44): a persona comercial diz "VOCÊ NÃO TEM ACESSO a contrato,
   * parcelas, boleto ou segunda via nesta raia" e manda escalar quem se diz
   * cotista. O agente recebia as 19 tools do cotista na mão e respondia que não
   * podia consultar — sem escalar, prometendo um atendente que ninguém acionou.
   * Na primeira pergunta da conversa, que é a que o cliente vê na demo.
   *
   * `comercialSemVinculo` é a MESMA condição que o hook de guardrail da 015c já
   * usa 20 linhas abaixo, com o comentário explicando esta exata armadilha. O
   * conserto é usar uma conta só para as duas decisões, para não divergirem de
   * novo na próxima spec que mexer no SDR.
   */
  const comercialSemVinculo = sdrDeps !== null && clienteId === '';

  // #47: com a conversa na fila, o agente sabe que o humano já foi acionado —
  // atende outros assuntos e não promete (nem escala) de novo o mesmo tema
  // 015: na raia do lead frio a persona é a comercial (personaSdr), se houver
  const personaBase = comercialSemVinculo
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

  /**
   * 015c: na raia do SDR entra um hook a mais. `preco.ts` barra percentual só
   * com dígito — "aplico três por cento" passa —, e o agente comercial é
   * justamente o que negocia. A raia do cotista fica exatamente como estava:
   * lá o classificador de intenção pega `negociar_preco` antes de responder.
   *
   * A condição é `clienteId === ''`, NÃO `sdrDeps` — a 045 abriu o SDR para o
   * cotista também, e usar as deps aqui ligaria o hook na raia errada. Ali o
   * vocabulário proibido aparece legitimamente: a KB fala em "abatimento do
   * frete", e `preco.ts` trata isso com rastreabilidade justamente para não
   * escalar toda citação de política. Este hook é ABSOLUTO e não faria essa
   * distinção.
   *
   * O cotista COMPRANDO não fica descoberto: ali o fluxo de venda é
   * determinístico e consome o turno antes do LLM — não há rascunho para barrar.
   */
  const runtime = createAgentRuntime({
    provider: deps.provider,
    guardrails: comercialSemVinculo
      ? [guardrailPreco(), guardrailPercentualSdr()]
      : [guardrailPreco()],
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
  /**
   * `seq` é chave de dedupe (`turnoId:seq`), então cada mensagem extra do turno
   * consome um número. Contar quantas saíram — em vez de assumir uma por fluxo,
   * como o `fluxoIniciado ? 3 : 2` fazia — é o que garante que um turno com
   * pagamento (que sai em 2+ mensagens) e reserva juntos não colida e perca
   * silenciosamente a segunda.
   */
  let proximaSeq = 2;
  if (resultado.fluxoPagamentoSolicitado && fluxoDeps && fusao.resultado === 'enviado') {
    fluxoIniciado = await iniciarFluxo(fluxoDeps, ctxFluxo);
    await enviarVarias(fluxoIniciado.mensagens, proximaSeq);
    proximaSeq += fluxoIniciado.mensagens.length;
  }
  let reservaIniciada: ResultadoFluxoReserva | null = null;
  if (resultado.fluxoReservaSolicitado && reservaDeps && fusao.resultado === 'enviado') {
    reservaIniciada = await iniciarFluxoReserva(reservaDeps, ctxFluxo);
    await enviarVarias(reservaIniciada.mensagens, proximaSeq);
    proximaSeq += reservaIniciada.mensagens.length;
  }
  /**
   * 040: o documento sai DEPOIS da frase do agente, e só se ela saiu. Turno
   * fundido ou descartado (#46) não entrega boleto: a resposta que o anunciava
   * nem foi enviada, e o arquivo chegando sozinho seria um não-sequitur no
   * WhatsApp de alguém.
   */
  let legendasEnviadas: readonly string[] = [];
  if (pedidosSegundaVia.length > 0 && fusao.resultado === 'enviado') {
    await enviarVarias(
      pedidosSegundaVia.map((p) => ({ texto: p.legenda, anexo: p.anexo })),
      proximaSeq,
    );
    proximaSeq += pedidosSegundaVia.length;
    if (fusao.resultado === 'enviado') legendasEnviadas = pedidosSegundaVia.map((p) => p.legenda);
  }
  const escalado =
    (resultado.escalado ||
      fluxoIniciado?.escalado === true ||
      reservaIniciada?.escalado === true) &&
    !filaHumano;
  return {
    ...resultado,
    // #47: escalada com a conversa JÁ na fila não é nova escalada — o ticket
    // não muda e a métrica de escalonamento não conta duas vezes
    escalado,
    escaladoTrigger: filaHumano
      ? null
      : (resultado.escaladoTrigger ??
        fluxoIniciado?.escaladoTrigger ??
        reservaIniciada?.escaladoTrigger ??
        null),
    eventos: [...resultado.eventos, ...(fluxoIniciado?.eventos ?? [])],
    tokensEntrada:
      resultado.tokensEntrada + usageExtra.entrada + (reservaIniciada?.tokensEntrada ?? 0),
    tokensSaida: resultado.tokensSaida + usageExtra.saida + (reservaIniciada?.tokensSaida ?? 0),
    fusao: fusao.resultado,
    /**
     * O trace guarda o que o contato REALMENTE recebeu. `fusao.textoEnviado`
     * sozinho não serve quando o turno saiu em várias mensagens: ele guarda só
     * a última — que, com a 040, seria a legenda do boleto, sem a frase do
     * agente que a anunciou.
     */
    respostaEnviada:
      fluxoIniciado || reservaIniciada || legendasEnviadas.length > 0
        ? [
            textoAgente,
            ...(fluxoIniciado?.mensagens ?? []),
            ...(reservaIniciada?.mensagens ?? []),
            ...legendasEnviadas,
          ]
            .filter((s) => s)
            .join('\n\n')
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
