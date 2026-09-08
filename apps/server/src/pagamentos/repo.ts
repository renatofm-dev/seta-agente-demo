import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  cobranca,
  cobrancaTitulo,
  contato,
  conversa,
  fluxoCobranca,
  pagamento,
  pspCliente,
  STATUS_COBRANCA_ABERTA,
} from '../db/schema.js';

/**
 * Acesso às tabelas da 014. Interface explícita para o decorator de
 * conciliação e o worker poderem receber um stub nos testes de unidade.
 */

export type FluxoRow = typeof fluxoCobranca.$inferSelect;
export type CobrancaRow = typeof cobranca.$inferSelect;
export type CobrancaTituloRow = typeof cobrancaTitulo.$inferSelect;

export interface PagoDoContrato {
  readonly tituloId: string;
  readonly origem: 'entrada' | 'saldo';
  readonly valorCentavos: number;
  readonly recebidoEm: Date;
}

export interface ContatoDaConversa {
  readonly waId: string;
  readonly nome: string | null;
  readonly clienteErpId: string;
  readonly documento: string | null;
}

export interface PagamentosRepo {
  fluxoAtivo(conversaId: string): Promise<FluxoRow | null>;
  /** Títulos com baixa registrada aqui (espelho) — insumo da conciliação. */
  pagosDoContrato(contratoId: string): Promise<PagoDoContrato[]>;
  cobrancasHoje(conversaId: string): Promise<number>;
  cobrancaPorId(id: string): Promise<CobrancaRow | null>;
  cobrancaAbertaPorReferencia(referencia: string): Promise<CobrancaRow | null>;
  cobrancaPorPsp(pspCobrancaId: string): Promise<CobrancaRow | null>;
  ultimaCobrancaPorReferencia(referencia: string): Promise<CobrancaRow | null>;
  titulosDe(cobrancaId: string): Promise<CobrancaTituloRow[]>;
  cobrancasRecentesDoContrato(contratoId: string, limite: number): Promise<CobrancaRow[]>;
  contatoDaConversa(conversaId: string): Promise<ContatoDaConversa | null>;
  pspClienteDe(psp: string, contratoId: string): Promise<string | null>;
  salvarPspCliente(psp: string, contratoId: string, pspClienteId: string): Promise<void>;
}

export function createPagamentosRepo(db: Db): PagamentosRepo {
  return {
    async fluxoAtivo(conversaId) {
      const [f] = await db
        .select()
        .from(fluxoCobranca)
        .where(and(eq(fluxoCobranca.conversaId, conversaId), ne(fluxoCobranca.etapa, 'encerrado')))
        .limit(1);
      return f ?? null;
    },

    async pagosDoContrato(contratoId) {
      const linhas = await db
        .select({
          tituloId: pagamento.tituloId,
          origem: cobrancaTitulo.origem,
          valorCentavos: pagamento.valorCentavos,
          recebidoEm: pagamento.recebidoEm,
        })
        .from(pagamento)
        .innerJoin(
          cobrancaTitulo,
          and(
            eq(cobrancaTitulo.cobrancaId, pagamento.cobrancaId),
            eq(cobrancaTitulo.tituloId, pagamento.tituloId),
          ),
        )
        .where(and(eq(pagamento.contratoId, contratoId), eq(pagamento.status, 'confirmado')));
      return linhas;
    },

    async cobrancasHoje(conversaId) {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(cobranca)
        .where(
          and(
            eq(cobranca.conversaId, conversaId),
            sql`${cobranca.criadoEm} >= date_trunc('day', now())`,
            ne(cobranca.status, 'cancelada'),
          ),
        );
      return r?.n ?? 0;
    },

    async cobrancaPorId(id) {
      const [c] = await db.select().from(cobranca).where(eq(cobranca.id, id));
      return c ?? null;
    },

    async cobrancaAbertaPorReferencia(referencia) {
      const [c] = await db
        .select()
        .from(cobranca)
        .where(
          and(
            eq(cobranca.referenciaExterna, referencia),
            inArray(cobranca.status, [...STATUS_COBRANCA_ABERTA]),
          ),
        )
        .orderBy(desc(cobranca.criadoEm))
        .limit(1);
      return c ?? null;
    },

    async cobrancaPorPsp(pspCobrancaId) {
      const [c] = await db
        .select()
        .from(cobranca)
        .where(eq(cobranca.pspCobrancaId, pspCobrancaId))
        .orderBy(desc(cobranca.criadoEm))
        .limit(1);
      return c ?? null;
    },

    async ultimaCobrancaPorReferencia(referencia) {
      const [c] = await db
        .select()
        .from(cobranca)
        .where(eq(cobranca.referenciaExterna, referencia))
        .orderBy(desc(cobranca.criadoEm))
        .limit(1);
      return c ?? null;
    },

    async titulosDe(cobrancaId) {
      return db
        .select()
        .from(cobrancaTitulo)
        .where(eq(cobrancaTitulo.cobrancaId, cobrancaId))
        .orderBy(cobrancaTitulo.vencimento);
    },

    async cobrancasRecentesDoContrato(contratoId, limite) {
      return db
        .select()
        .from(cobranca)
        .where(eq(cobranca.contratoId, contratoId))
        .orderBy(desc(cobranca.criadoEm))
        .limit(limite);
    },

    async contatoDaConversa(conversaId) {
      const [r] = await db
        .select({
          waId: conversa.waId,
          nome: contato.nome,
          clienteErpId: contato.clienteErpId,
          documento: contato.documento,
        })
        .from(conversa)
        .innerJoin(contato, eq(contato.waId, conversa.waId))
        .where(eq(conversa.id, conversaId));
      return r ?? null;
    },

    async pspClienteDe(psp, contratoId) {
      const [r] = await db
        .select({ id: pspCliente.pspClienteId })
        .from(pspCliente)
        .where(and(eq(pspCliente.psp, psp), eq(pspCliente.contratoId, contratoId)));
      return r?.id ?? null;
    },

    async salvarPspCliente(psp, contratoId, pspClienteId) {
      await db
        .insert(pspCliente)
        .values({ psp, contratoId, pspClienteId })
        .onConflictDoUpdate({
          target: [pspCliente.psp, pspCliente.contratoId],
          set: { pspClienteId },
        });
    },
  };
}
