import type { DocumentoErp } from '@seta/erp-api-tse';
import { newTraceId } from '@seta/observability';
import {
  JanelaFechadaError,
  type OutboundGateway,
  type OutboundTemplate,
  OutboundTemplateSchema,
} from '@seta/wa-meta';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { z } from 'zod';
import { FILA_OUTBOX, FILA_OUTBOX_SWEEP, OUTBOX_RETRY_LIMIT } from '../boss.js';
import type { Db } from '../db/index.js';
import { conversa, mensagem, outbox } from '../db/schema.js';
import { aplicarTransicao, garantirTicket } from './tickets.js';

/**
 * Outbox: toda resposta vira linha com dedupe (turnoId+seq) antes de qualquer
 * side effect externo; o worker envia via gateway com retry exponencial do
 * pg-boss e registra a mensagem `out` para os webhooks de status atualizarem.
 */

export interface OutboxDeps {
  readonly db: Db;
  readonly boss: PgBoss;
}

export type OutboundItem =
  | {
      /** Resposta do bot: dedupe por turno+seq. */
      readonly conversaId: string;
      readonly turnoId: string;
      readonly seq: number;
      readonly texto: string;
      readonly autor?: 'bot';
    }
  | {
      /** Resposta manual do atendente (007): sem turno; dedupe por chave do cliente. */
      readonly conversaId: string;
      readonly turnoId?: undefined;
      readonly chave: string;
      readonly texto: string;
      readonly autor: 'atendente';
      /** #45: user.id de quem respondeu — propaga à mensagem para a thread. */
      readonly atendenteId: string;
    }
  | {
      /**
       * 014: mensagem do bot FORA de um turno (worker de emissão, confirmação de
       * pagamento pelo webhook): dedupe por chave (`cobranca:{id}:{seq}`).
       */
      readonly conversaId: string;
      readonly turnoId?: undefined;
      readonly chave: string;
      readonly texto: string;
      readonly autor: 'bot';
      /**
       * 043: template equivalente a este texto, usado se a janela fechar antes
       * do envio. Sem ele, janela fechada continua virando ticket (014).
       */
      readonly template?: TemplateDaLinha;
      /** 040: manda como DOCUMENTO, com o `texto` de legenda. */
      readonly anexo?: AnexoDaLinha;
    }
  | {
      /**
       * 040: documento do bot DENTRO de um turno — a 2ª via sai como seq 2..n
       * logo depois da frase do agente, e o dedupe por turno+seq é o que faz
       * um reprocesso do turno não mandar o boleto duas vezes.
       */
      readonly conversaId: string;
      readonly turnoId: string;
      readonly seq: number;
      readonly texto: string;
      readonly autor?: 'bot';
      readonly anexo: AnexoDaLinha;
    };

/**
 * Só o INSERT do outbox (aceita tx — #46: o turno-handler insere na mesma
 * transação da checagem de pendentes). O job do worker é enviado à parte,
 * DEPOIS do commit, via enviarJobOutbound.
 */
/**
 * 043: o que a linha carrega para reenviar como template. É `Omit<...,'to'>`
 * porque o destinatário sai da conversa no instante do envio, não da gravação.
 */
export type TemplateDaLinha = Omit<OutboundTemplate, 'to'>;

/** JSONB é fronteira de entrada: valida na leitura, nunca confia na coluna. */
const TemplateDaLinhaSchema = OutboundTemplateSchema.omit({ to: true });

/**
 * 040: o DESCRITOR do anexo. A linha diz o que buscar e com que nome entregar;
 * os bytes só existem entre o ERP e a Meta, dentro do job.
 *
 * Buscar na hora do envio (e não na hora de enfileirar) é o que faz o retry do
 * pg-boss continuar valendo: cada tentativa pega o arquivo de novo, em vez de
 * reenviar um `media_id` que a Meta já pode ter expirado.
 */
export const AnexoDaLinhaSchema = z.object({
  tipo: z.literal('segunda_via'),
  /** `idcontafinanceira` — o mesmo `titulo_id` de `v_titulo`. */
  contaFinanceiraId: z.string().min(1),
  filename: z.string().min(1).max(240),
});
export type AnexoDaLinha = z.infer<typeof AnexoDaLinhaSchema>;

/**
 * Quem sabe buscar o arquivo. É um port estreito de propósito: o worker do
 * outbox não precisa (nem deve) enxergar o `ErpWriter` inteiro.
 */
export interface ResolvedorAnexo {
  obterSegundaVia(contaFinanceiraId: string): Promise<DocumentoErp | null>;
}

/**
 * O ERP respondeu que NÃO TEM o arquivo. É resposta, não instabilidade: não se
 * re-tenta, marca a linha e chama humano — o mesmo tratamento terminal que a
 * janela fechada recebe, e pelo mesmo motivo (tentar de novo não muda nada).
 */
/**
 * Texto fixo, não rascunho de LLM — como os de `packages/cobranca`. Diz o que
 * houve sem prometer prazo, porque quem vai resolver é a pessoa do outro lado
 * do ticket, e ela é que sabe quando.
 */
export const TEXTO_ANEXO_INDISPONIVEL =
  'Não consegui gerar o arquivo do seu boleto agora — o sistema não devolveu o documento. ' +
  'Já avisei um atendente, que vai te enviar em seguida. Desculpe pela demora!';

export class AnexoIndisponivelError extends Error {
  constructor(readonly contaFinanceiraId: string) {
    super(`ERP não devolveu a 2ª via da conta financeira ${contaFinanceiraId}`);
    this.name = 'AnexoIndisponivelError';
  }
}

export async function inserirOutbound(
  db: Pick<Db, 'insert'>,
  item: OutboundItem,
): Promise<{ duplicada: boolean; outboxId?: string }> {
  const semTurno = item.turnoId === undefined;
  const dedupeKey = semTurno
    ? `${item.autor === 'atendente' ? 'manual' : 'bot'}:${item.chave}`
    : `${item.turnoId}:${item.seq}`;
  const [linha] = await db
    .insert(outbox)
    .values({
      id: newTraceId(),
      conversaId: item.conversaId,
      turnoId: semTurno ? null : item.turnoId,
      seq: semTurno ? 1 : item.seq,
      dedupeKey,
      autor: item.autor ?? 'bot',
      atendenteId: semTurno && item.autor === 'atendente' ? item.atendenteId : null,
      texto: item.texto,
      template: semTurno && item.autor !== 'atendente' ? (item.template ?? null) : null,
      anexo: 'anexo' in item ? (item.anexo ?? null) : null,
    })
    .onConflictDoNothing({ target: outbox.dedupeKey })
    .returning();
  if (!linha) return { duplicada: true };
  return { duplicada: false, outboxId: linha.id };
}

export async function enviarJobOutbound(boss: PgBoss, outboxId: string): Promise<void> {
  await boss.send(FILA_OUTBOX, { outboxId });
}

export async function enqueueOutbound(
  deps: OutboxDeps,
  item: OutboundItem,
): Promise<{ duplicada: boolean; outboxId?: string }> {
  const r = await inserirOutbound(deps.db, item);
  if (!r.duplicada && r.outboxId) await enviarJobOutbound(deps.boss, r.outboxId);
  return r;
}

export interface OutboxWorkerDeps extends OutboxDeps {
  readonly gateway: OutboundGateway;
  readonly logger: Logger;
  /** 040: sem ele, linha com anexo não é enviada como texto — escala. */
  readonly anexos?: ResolvedorAnexo;
}

export async function registerOutboxWorker(deps: OutboxWorkerDeps): Promise<void> {
  await deps.boss.work<{ outboxId: string }>(
    FILA_OUTBOX,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        const retryCount = (job as unknown as { retryCount?: number }).retryCount ?? 0;
        await enviarLinha(deps, job.data.outboxId, retryCount >= OUTBOX_RETRY_LIMIT);
      }
    },
  );
}

/** #29: entrega indeliverável marca o ticket — humano fica sabendo na hora. */
async function marcarTicketPorFalha(
  deps: OutboxWorkerDeps,
  conversaId: string,
  motivo: string,
): Promise<void> {
  try {
    const t = await garantirTicket(deps.db, conversaId);
    if (t.status === 'bot_ativo') {
      await aplicarTransicao(deps.db, t, 'aguardando_humano', 'bot', { motivo });
    }
  } catch (err) {
    deps.logger.error({ err, conversaId }, 'falha ao marcar ticket após erro de envio');
  }
}

export async function enviarLinha(
  deps: OutboxWorkerDeps,
  outboxId: string,
  ultimaTentativa = false,
): Promise<void> {
  const [linha] = await deps.db.select().from(outbox).where(eq(outbox.id, outboxId));
  if (linha?.status !== 'pendente') return; // inexistente ou já resolvida (dedupe/reprocesso)
  const [conv] = await deps.db.select().from(conversa).where(eq(conversa.id, linha.conversaId));
  if (!conv) throw new Error(`outbox ${outboxId} sem conversa`);

  /**
   * 040: `parse`, não `safeParse` — descritor corrompido NÃO pode cair de volta
   * em texto puro. O cotista receberia a legenda ("segue o boleto da parcela
   * 3") sem boleto nenhum, e ninguém ficaria sabendo. Lançar aqui manda o caso
   * para o caminho de falha, que acaba em ticket.
   */
  const anexo = linha.anexo === null ? null : AnexoDaLinhaSchema.parse(linha.anexo);
  /**
   * 043 + decisão do Renato em 24/09: a linha que traz template SAI como
   * template, com a janela aberta ou fechada. Antes ele era só plano B do
   * reengajamento, e o efeito era que o card de pagamento — valor, vencimento,
   * link e o botão de copiar o código — **nunca aparecia na demo**, porque ali
   * a janela está sempre aberta: o cliente acabou de escrever. O que o cotista
   * recebia era texto puro, e o único elemento tocável da conversa acabava
   * sendo o domínio que mora DENTRO do BR Code do PIX — que não abre nada.
   */
  const template = TemplateDaLinhaSchema.safeParse(linha.template);

  try {
    const janela = { expiraEm: conv.janelaExpiraEm };
    let waMessageId: string;
    if (anexo) {
      const doc = await (deps.anexos?.obterSegundaVia(anexo.contaFinanceiraId) ?? null);
      if (!doc) throw new AnexoIndisponivelError(anexo.contaFinanceiraId);
      ({ waMessageId } = await deps.gateway.sendDocument(
        {
          to: conv.waId,
          bytes: doc.bytes,
          mime: doc.mime,
          filename: anexo.filename,
          caption: linha.texto,
        },
        janela,
      ));
    } else if (template.success) {
      ({ waMessageId } = await deps.gateway.sendTemplate({ ...template.data, to: conv.waId }));
    } else {
      ({ waMessageId } = await deps.gateway.send({ to: conv.waId, body: linha.texto }, janela));
    }
    await deps.db.transaction(async (tx) => {
      await tx
        .update(outbox)
        .set({
          status: 'enviada',
          waMessageId,
          tentativas: sql`${outbox.tentativas} + 1`,
          atualizadoEm: new Date(),
        })
        .where(eq(outbox.id, outboxId));
      await tx.insert(mensagem).values({
        id: newTraceId(),
        conversaId: conv.id,
        direcao: 'out',
        autor: linha.autor,
        atendenteId: linha.atendenteId,
        waMessageId,
        texto: linha.texto,
        anexoNome: anexo?.filename ?? null,
        status: 'enviada',
        turnoId: linha.turnoId,
      });
    });
  } catch (err) {
    /**
     * 040: o ERP não tem o arquivo. Re-tentar não faz o boleto aparecer, então
     * é terminal — e vai para humano, nunca para o silêncio.
     */
    if (err instanceof AnexoIndisponivelError) {
      await deps.db
        .update(outbox)
        .set({ status: 'falha', atualizadoEm: new Date() })
        .where(eq(outbox.id, outboxId));
      /**
       * Aqui o ticket sozinho não basta, e é o que separa este caso do #29: o
       * agente ACABOU de dizer "já estou te enviando". Sumir depois de prometer
       * é a pior versão do silêncio — pior do que nunca ter oferecido. Então
       * entra uma mensagem honesta, dedupada pelo id da linha que falhou, e o
       * humano assume por cima dela.
       */
      await enqueueOutbound(deps, {
        conversaId: conv.id,
        chave: `anexo-indisponivel:${outboxId}`,
        texto: TEXTO_ANEXO_INDISPONIVEL,
        autor: 'bot',
      });
      await marcarTicketPorFalha(deps, conv.id, 'ERP não devolveu o boleto pedido pelo cotista');
      deps.logger.error(
        { outboxId, contaFinanceiraId: err.contaFinanceiraId },
        'outbox: 2ª via indisponível no ERP — linha em falha',
      );
      return;
    }
    if (err instanceof JanelaFechadaError) {
      // Envio LIVRE fora da janela de 24h não existe na Meta (só template aprovado — 013 usa
      // nos disparos e no aviso de pagamento).
      // Linha COM template não chega aqui: ela nem passa pelo envio livre, sai
      // por `sendTemplate` acima. Quem cai neste ponto é a linha de texto —
      // inclusive as linhas 2+ de uma emissão (o copia-e-cola, a linha
      // digitável), que seguem sem template próprio de propósito: anexá-lo
      // abriria uma segunda conversa cobrada dizendo a mesma coisa.
      // Comportamento da 014: marca a linha E o ticket.
      await deps.db
        .update(outbox)
        .set({ status: 'janela_fechada', atualizadoEm: new Date() })
        .where(eq(outbox.id, outboxId));
      await marcarTicketPorFalha(deps, conv.id, 'janela de 24h fechada — reengajar por template');
      deps.logger.warn({ outboxId, waId: conv.waId }, 'janela de 24h fechada — envio abortado');
      return;
    }
    await deps.db
      .update(outbox)
      .set({ tentativas: sql`${outbox.tentativas} + 1`, atualizadoEm: new Date() })
      .where(eq(outbox.id, outboxId));
    if (ultimaTentativa) {
      // #29: dead-letter — a mensagem NÃO some em silêncio: linha vira `falha`
      // e o ticket escala para um humano reenviar/decidir
      await deps.db
        .update(outbox)
        .set({ status: 'falha', atualizadoEm: new Date() })
        .where(eq(outbox.id, outboxId));
      await marcarTicketPorFalha(deps, conv.id, 'falha ao enviar resposta ao contato');
      deps.logger.error({ err, outboxId }, 'outbox: retries esgotados — linha em falha');
      return;
    }
    throw err; // pg-boss re-tenta com backoff exponencial (config da fila)
  }
}

/**
 * #29: varredura de órfãs — crash entre o INSERT do outbox e o boss.send deixa
 * linha `pendente` sem job. Recoloca na fila linhas pendentes velhas o bastante
 * para o ciclo de retries original já ter morrido (sem risco de envio duplo).
 */
export const ORFA_APOS_MS = 10 * 60 * 1000;

export async function varrerPendentesOrfas(deps: OutboxWorkerDeps): Promise<number> {
  const corte = new Date(Date.now() - ORFA_APOS_MS);
  const orfas = await deps.db
    .select({ id: outbox.id })
    .from(outbox)
    .where(sql`${outbox.status} = 'pendente' AND ${outbox.atualizadoEm} < ${corte}`);
  for (const linha of orfas) {
    await deps.boss.send(FILA_OUTBOX, { outboxId: linha.id }, { singletonKey: linha.id });
  }
  if (orfas.length > 0) {
    deps.logger.warn({ n: orfas.length }, 'outbox: pendentes órfãs re-enfileiradas');
  }
  return orfas.length;
}

export async function registerOutboxSweeper(deps: OutboxWorkerDeps): Promise<void> {
  await deps.boss.schedule(FILA_OUTBOX_SWEEP, '* * * * *');
  await deps.boss.work(FILA_OUTBOX_SWEEP, async () => {
    await varrerPendentesOrfas(deps);
  });
}
