import { mensagensEmitida, referenciaCliente, TEXTO_FALHA_EMISSAO } from '@seta/cobranca';
import { type PaymentProvider, PspAuthError, PspBusinessError } from '@seta/payment-provider';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { COBRANCA_RETRY_LIMIT, FILA_COBRANCA_EMITIR } from '../boss.js';
import type { Db } from '../db/index.js';
import { cobranca } from '../db/schema.js';
import type { Env } from '../env.js';
import { enqueueOutbound, enviarJobOutbound, inserirOutbound } from '../wa/outbox.js';
import { escalarTicketCobranca, TRIGGER_FALHA_EMISSAO } from './escalar.js';
import type { PixRecebedor } from './order-details.js';
import type { PagamentosRepo } from './repo.js';
import { linhasQueSaem, montarTemplateCobranca } from './template-cobranca.js';

/**
 * Worker de emissão (014): materializa a cobrança no PSP e manda o meio de
 * pagamento pelo outbox. Idempotente (status ≠ emitindo ⇒ nada), consulta o
 * PSP por referência antes de criar, e distingue os erros: auth/negócio vão
 * para humano na hora; indisponibilidade re-tenta com o backoff do pg-boss.
 */

export interface EmitirDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly repo: PagamentosRepo;
  readonly psp: PaymentProvider;
  readonly logger: Logger;
  /** Nome do cliente (client.yaml) — vai na descrição da cobrança. */
  readonly nomeCliente: string;
  /** 043: modelos aprovados por método; ausente ⇒ janela fechada vira ticket. */
  readonly env: Pick<
    Env,
    | 'WA_TEMPLATE_COBRANCA_PIX'
    | 'WA_TEMPLATE_COBRANCA_BOLETO'
    | 'WA_TEMPLATE_BOLETO_SEGUNDA_VIA'
    | 'WA_TEMPLATE_COBRANCA_CARTAO'
  >;
  /** 043: recebedor do PIX (client.yaml); ausente ⇒ sem template de cobrança. */
  readonly pixRecebedor: PixRecebedor | null;
}

export interface JobEmitir {
  readonly cobrancaId: string;
  /** Cobrança antiga (troca de método) a cancelar no PSP antes de criar a nova. */
  readonly cancelarPspId?: string;
}

export async function registerCobrancaEmitirWorker(deps: EmitirDeps): Promise<void> {
  await deps.boss.work<JobEmitir>(FILA_COBRANCA_EMITIR, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const retryCount = (job as unknown as { retryCount?: number }).retryCount ?? 0;
      await processarEmissao(deps, job.data, retryCount >= COBRANCA_RETRY_LIMIT);
    }
  });
}

export async function processarEmissao(
  deps: EmitirDeps,
  job: JobEmitir,
  ultimaTentativa: boolean,
): Promise<void> {
  const c = await deps.repo.cobrancaPorId(job.cobrancaId);
  if (c?.status !== 'emitindo') return; // já emitida/cancelada — reprocesso não repete

  const [titulos, contato] = await Promise.all([
    deps.repo.titulosDe(c.id),
    deps.repo.contatoDaConversa(c.conversaId),
  ]);

  try {
    if (job.cancelarPspId) {
      await deps.psp.cancelarCobranca(job.cancelarPspId).catch((err: unknown) => {
        deps.logger.warn(
          { err, pspId: job.cancelarPspId },
          'não cancelou a cobrança antiga no PSP',
        );
      });
    }

    let clienteId = c.pspClienteId ?? (await deps.repo.pspClienteDe(deps.psp.nome, c.contratoId));
    if (!clienteId) {
      if (!contato?.documento) {
        throw new PspBusinessError(
          'vínculo sem CPF — não é possível criar o cliente no PSP',
          400,
          [],
        );
      }
      clienteId = (
        await deps.psp.garantirCliente({
          documento: contato.documento,
          nome: contato.nome ?? `Titular do contrato ${c.contratoId}`,
          telefone: contato.waId,
          referenciaExterna: referenciaCliente(c.contratoId),
        })
      ).id;
      await deps.repo.salvarPspCliente(deps.psp.nome, c.contratoId, clienteId);
    }

    // anti-duplicidade: o PSP é consultado pela referência ANTES de criar
    const existente = await deps.psp.buscarPorReferencia(c.referenciaExterna);
    const reaproveita =
      existente !== null &&
      existente.status === 'pendente' &&
      existente.valorCentavos === c.valorCentavos;
    const parcelas = titulos
      .map(
        (t) => `parcela ${t.parcela}${t.totalParcelas ? `/${t.totalParcelas}` : ''} (${t.origem})`,
      )
      .join(', ');
    const cob = reaproveita
      ? existente
      : await deps.psp.criarCobranca({
          clienteId,
          valorCentavos: c.valorCentavos,
          vencimento: c.vencimentoPsp,
          descricao: `${deps.nomeCliente} — contrato ${c.contratoId} — ${parcelas}`.slice(0, 500),
          referenciaExterna: c.referenciaExterna,
          metodo: c.metodo,
        });

    const pix = c.metodo === 'pix' ? await deps.psp.obterPix(cob.id) : null;
    const linha = c.metodo === 'boleto' ? await deps.psp.obterLinhaDigitavel(cob.id) : null;

    const dados = {
      metodo: c.metodo,
      valorCentavos: c.valorCentavos,
      vencimento: cob.vencimento || c.vencimentoPsp,
      urlFatura: cob.urlFatura,
      urlBoleto: cob.urlBoleto,
      linhaDigitavel: linha?.linhaDigitavel ?? null,
      pixCopiaCola: pix?.payload ?? null,
      // sempre primeira entrega do ponto de vista do cotista: `reaproveita` diz
      // que o PSP já tinha a cobrança (retry de job), não que ele já a recebeu.
      // O reenvio de verdade mora em `fluxo.ts`, e lá a janela está aberta por
      // definição — quando existir reenvio fora da janela (040/044), é ele que
      // passa `reenvio: true` e o montador escolhe `boleto_segunda_via`.
      reenvio: false,
      // #43: só quando um humano liberou. `aprovadoPor` é gravado pela tela de
      // Cobranças; emissão dentro da alçada chega aqui com ele nulo e a
      // mensagem fica exatamente como era.
      ...(c.aprovadoPor ? { aprovacao: { qtdParcelas: titulos.length } } : {}),
    };
    const textos = mensagensEmitida(dados);
    const template =
      montarTemplateCobranca(dados, c, titulos, {
        recebedor: deps.pixRecebedor,
        nomes: {
          pix: deps.env.WA_TEMPLATE_COBRANCA_PIX,
          boleto: deps.env.WA_TEMPLATE_COBRANCA_BOLETO,
          boletoSegundaVia: deps.env.WA_TEMPLATE_BOLETO_SEGUNDA_VIA,
          cartao: deps.env.WA_TEMPLATE_COBRANCA_CARTAO,
        },
      }) ?? undefined;

    const outboxIds: string[] = [];
    await deps.db.transaction(async (tx) => {
      await tx
        .update(cobranca)
        .set({
          status: 'emitida',
          pspClienteId: clienteId,
          pspCobrancaId: cob.id,
          urlFatura: cob.urlFatura,
          urlBoleto: cob.urlBoleto,
          linhaDigitavel: linha?.linhaDigitavel ?? null,
          pixCopiaCola: pix?.payload ?? null,
          pixExpiraEm: pix?.expiraEm ?? null,
          vencimentoPsp: cob.vencimento || c.vencimentoPsp,
          tentativas: sql`${cobranca.tentativas} + 1`,
          atualizadoEm: new Date(),
        })
        .where(eq(cobranca.id, c.id));
      /**
       * 043: o template vai SÓ na linha 1 — anexá-lo às linhas 2+ abriria uma
       * segunda conversa cobrada dizendo a mesma coisa.
       *
       * E quando o card do PIX sai, a linha do copia-e-cola CRU não sai: o
       * código já está dentro do botão "Copy Pix code", e mandá-lo de novo em
       * texto entrega o mesmo código duas vezes. Vale só para o PIX: o template
       * do boleto leva a linha digitável como variável do corpo, sem botão de
       * copiar, então ali a mensagem crua é a única forma copiável e continua.
       */
      for (const [i, texto] of linhasQueSaem(textos, template).entries()) {
        const r = await inserirOutbound(tx, {
          conversaId: c.conversaId,
          chave: `cobranca:${c.id}:${i + 1}`,
          texto,
          autor: 'bot',
          ...(i === 0 && template ? { template } : {}),
        });
        if (r.outboxId) outboxIds.push(r.outboxId);
      }
    });
    // jobs DEPOIS do commit — rollback nunca deixa job órfão
    for (const id of outboxIds) await enviarJobOutbound(deps.boss, id);
    deps.logger.info(
      { cobrancaId: c.id, pspId: cob.id, metodo: c.metodo, reaproveitada: reaproveita },
      'cobrança emitida',
    );
  } catch (err) {
    // auth e negócio não melhoram com retry; indisponibilidade (PSP ou banco) sim
    const definitivo =
      err instanceof PspAuthError || err instanceof PspBusinessError || ultimaTentativa;
    if (!definitivo) {
      await deps.db
        .update(cobranca)
        .set({ tentativas: sql`${cobranca.tentativas} + 1`, atualizadoEm: new Date() })
        .where(eq(cobranca.id, c.id));
      deps.logger.warn({ err, cobrancaId: c.id }, 'emissão falhou — pg-boss re-tenta');
      throw err;
    }
    await falhar(deps, c.id, c.conversaId, err);
  }
}

async function falhar(deps: EmitirDeps, cobrancaId: string, conversaId: string, err: unknown) {
  const motivo = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  await deps.db
    .update(cobranca)
    .set({ status: 'falha', motivo, atualizadoEm: new Date() })
    .where(eq(cobranca.id, cobrancaId));
  deps.logger.error({ err, cobrancaId }, 'emissão da cobrança falhou em definitivo');
  await escalarTicketCobranca(
    deps.db,
    conversaId,
    TRIGGER_FALHA_EMISSAO,
    `falha ao emitir cobrança no PSP: ${motivo}`,
    { refId: cobrancaId },
  );
  await enqueueOutbound(
    { db: deps.db, boss: deps.boss },
    { conversaId, chave: `cobranca:${cobrancaId}:falha`, texto: TEXTO_FALHA_EMISSAO, autor: 'bot' },
  );
}
