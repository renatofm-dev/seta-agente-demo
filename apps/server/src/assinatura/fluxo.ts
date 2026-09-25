import type { AssinaturaProvider, EventoAssinatura } from '@seta/assinatura';
import { newTraceId } from '@seta/observability';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Db } from '../db/index.js';
import { assinatura } from '../db/schema.js';
import { enqueueOutbound, enviarJobOutbound } from '../wa/outbox.js';

/**
 * 046 — a assinatura do contrato, do envio ao aceite.
 *
 * Roda **depois** que a venda registrou o contrato no ERP: paga o sinal,
 * contrato no ERP, depois assina (decisão do Renato em 24/09). Por isso o
 * documento sempre existe quando este fluxo começa — e, se o ERP não o
 * devolver, o comprador ouve isso em vez de nada.
 *
 * Nada aqui passa pelo modelo: é efeito de worker, como o boleto da 040. O PDF
 * atravessa entre o ERP e o provedor de assinatura e não é guardado por nós.
 */

export interface DocumentoErpLeitor {
  obterContratoPdf(contratoId: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

export interface AssinaturaDeps {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly logger: {
    info(o: Record<string, unknown>, m: string): void;
    warn(o: Record<string, unknown>, m: string): void;
    error(o: Record<string, unknown>, m: string): void;
  };
  readonly provider: AssinaturaProvider;
  readonly erp: DocumentoErpLeitor;
}

export interface VendaParaAssinar {
  readonly id: string;
  readonly conversaId: string;
  readonly contratoErpId: string;
  readonly compradorNome: string;
  readonly compradorCpf?: string;
  readonly compradorEmail?: string;
}

export const TEXTO_CONTRATO_NAO_SAIU =
  'O contrato foi registrado, mas não consegui gerar o arquivo para assinatura agora. ' +
  'Já avisei um atendente, que vai te enviar em seguida — sua compra está garantida.';

export function textoParaAssinar(link: string): string {
  return (
    'Seu contrato está pronto para assinar! ✍️\n' +
    'Abra o link, confira os dados e assine pelo celular — leva menos de um minuto.\n' +
    link
  );
}

export const TEXTO_ASSINADO =
  'Contrato assinado! 🎉 Recebi a confirmação aqui. Segue a via para você guardar.';

/** Nome que o comprador vê no WhatsApp. Só `[a-z0-9-]`, como na 040. */
export function nomeDoArquivoContrato(contratoErpId: string): string {
  const id = String(contratoErpId).replace(/\D/g, '') || '0';
  return `contrato-${id}.pdf`;
}

/**
 * Cria o documento no provedor e manda o link. Idempotente pela `assinatura`
 * pendente da venda: reenviar não cria um segundo documento — devolve o link
 * que já existe, que é o que o índice parcial `assinatura_venda_uq` garante.
 */
export async function enviarParaAssinatura(
  deps: AssinaturaDeps,
  v: VendaParaAssinar,
): Promise<{ estado: 'enviada' | 'reenviada' | 'sem_documento' }> {
  const [existente] = await deps.db
    .select()
    .from(assinatura)
    .where(and(eq(assinatura.vendaId, v.id), eq(assinatura.estado, 'pendente')));

  if (existente) {
    await mandar(
      deps,
      v.conversaId,
      `assinatura:${existente.id}:link`,
      textoParaAssinar(existente.link),
    );
    return { estado: 'reenviada' };
  }

  const doc = await deps.erp.obterContratoPdf(v.contratoErpId);
  if (!doc) {
    /**
     * O ERP não tem o documento. Não se re-tenta (não vai aparecer) e não se
     * cala: o comprador acabou de pagar e de ouvir que o contrato foi
     * registrado. A escalada de quem trata isso é do worker da venda, que tem
     * o ticket na mão.
     */
    deps.logger.error(
      { vendaId: v.id, contratoErpId: v.contratoErpId },
      'assinatura: ERP não devolveu o contrato em PDF',
    );
    await mandar(deps, v.conversaId, `assinatura:${v.id}:sem-documento`, TEXTO_CONTRATO_NAO_SAIU);
    return { estado: 'sem_documento' };
  }

  const criado = await deps.provider.criarDocumento({
    nome: `Contrato ${v.contratoErpId}`,
    pdf: doc.bytes,
    signatarios: [
      {
        nome: v.compradorNome,
        ...(v.compradorEmail ? { email: v.compradorEmail } : {}),
        ...(v.compradorCpf ? { cpf: v.compradorCpf } : {}),
      },
    ],
  });
  const link = criado.links[0]?.url;
  if (!link) throw new Error('assinatura: provedor não devolveu link de assinatura');

  const id = newTraceId();
  await deps.db.insert(assinatura).values({
    id,
    vendaId: v.id,
    conversaId: v.conversaId,
    provedor: deps.provider.nome,
    documentoId: criado.id,
    contratoErpId: v.contratoErpId,
    estado: 'pendente',
    link,
  });
  deps.logger.info(
    { vendaId: v.id, assinaturaId: id, provedor: deps.provider.nome, documentoId: criado.id },
    'assinatura: documento criado',
  );

  await mandar(deps, v.conversaId, `assinatura:${id}:link`, textoParaAssinar(link));
  return { estado: 'enviada' };
}

/**
 * Aplica o evento do provedor. Chega pelo webhook — e chega mais de uma vez:
 * provedor re-tenta o que não responde 200. Por isso a transição é por estado,
 * não por contagem, e reprocessar um evento já aplicado não manda a via de novo.
 */
export async function registrarEventoAssinatura(
  deps: AssinaturaDeps,
  evento: EventoAssinatura,
): Promise<'aplicado' | 'ignorado' | 'repetido'> {
  const [linha] = await deps.db
    .select()
    .from(assinatura)
    .where(
      and(
        eq(assinatura.provedor, deps.provider.nome),
        eq(assinatura.documentoId, evento.idDocumento),
      ),
    );
  if (!linha) {
    deps.logger.warn(
      { documentoId: evento.idDocumento, provedor: deps.provider.nome },
      'assinatura: evento de documento desconhecido',
    );
    return 'ignorado';
  }
  if (evento.estado === 'pendente') return 'ignorado';
  if (linha.estado !== 'pendente') return 'repetido';

  await deps.db
    .update(assinatura)
    .set({
      estado: evento.estado,
      assinadoEm: evento.assinadoEm ? new Date(evento.assinadoEm) : new Date(),
      urlAssinado: evento.urlAssinado,
      atualizadoEm: new Date(),
    })
    .where(eq(assinatura.id, linha.id));

  deps.logger.info(
    { assinaturaId: linha.id, estado: evento.estado, vendaId: linha.vendaId },
    'assinatura: evento aplicado',
  );

  if (evento.estado !== 'assinada') return 'aplicado';

  // a frase primeiro, a via em seguida — a mesma ordem da 040, para o arquivo
  // nunca chegar como não-sequitur
  await mandar(deps, linha.conversaId, `assinatura:${linha.id}:assinada`, TEXTO_ASSINADO);
  await mandar(
    deps,
    linha.conversaId,
    `assinatura:${linha.id}:via`,
    `Contrato ${linha.contratoErpId} — via assinada.`,
    {
      tipo: 'contrato',
      contratoErpId: linha.contratoErpId,
      filename: nomeDoArquivoContrato(linha.contratoErpId),
    },
  );
  return 'aplicado';
}

async function mandar(
  deps: AssinaturaDeps,
  conversaId: string,
  chave: string,
  texto: string,
  anexo?: { tipo: 'contrato'; contratoErpId: string; filename: string },
): Promise<void> {
  const r = await enqueueOutbound(
    { db: deps.db, boss: deps.boss },
    { conversaId, chave, texto, autor: 'bot', ...(anexo ? { anexo } : {}) },
  );
  if (r.outboxId) await enviarJobOutbound(deps.boss, r.outboxId);
}
