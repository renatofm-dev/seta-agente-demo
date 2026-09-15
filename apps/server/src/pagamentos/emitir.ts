import {
  formatarData,
  formatarReais,
  mensagensEmitida,
  referenciaCliente,
  TEXTO_FALHA_EMISSAO,
} from '@seta/cobranca';
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
import { montarBotaoPix, type PixRecebedor } from './order-details.js';
import type { PagamentosRepo } from './repo.js';

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
  /** 043: modelo com botão order_details; ausente ⇒ janela fechada vira ticket. */
  readonly env: Pick<Env, 'WA_TEMPLATE_COBRANCA_PIX'>;
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

    const botao = montarBotaoPix(
      { ...c, pixCopiaCola: pix?.payload ?? null, valorCentavos: c.valorCentavos },
      titulos,
      deps.pixRecebedor,
    );
    const modelo = deps.env.WA_TEMPLATE_COBRANCA_PIX;
    // as variáveis seguem a ordem do corpo aprovado do template `cobranca_pix`:
    // {{1}} valor, {{2}} vencimento, {{3}} link. Mudar o corpo na Meta exige
    // mudar esta lista junto — a Meta recusa aridade diferente no envio.
    const template =
      botao && modelo
        ? {
            nome: modelo,
            idioma: 'pt_BR',
            variaveis: [
              formatarReais(c.valorCentavos),
              formatarData(cob.vencimento || c.vencimentoPsp),
              cob.urlFatura,
            ],
            botao,
          }
        : undefined;

    const textos = mensagensEmitida({
      metodo: c.metodo,
      valorCentavos: c.valorCentavos,
      vencimento: cob.vencimento || c.vencimentoPsp,
      urlFatura: cob.urlFatura,
      urlBoleto: cob.urlBoleto,
      linhaDigitavel: linha?.linhaDigitavel ?? null,
      pixCopiaCola: pix?.payload ?? null,
      reenvio: false,
    });

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
      // 043: o template vai SÓ na linha 1. As linhas 2+ são o copia-e-cola cru,
      // que já viaja dentro do order_details — anexar nelas abriria uma segunda
      // conversa de template, cobrada, dizendo a mesma coisa.
      for (const [i, texto] of textos.entries()) {
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
