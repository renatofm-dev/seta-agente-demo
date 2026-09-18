import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { fluxoSdr, lead, propostaSdr, STATUS_PROPOSTA_SDR_ABERTA } from '../db/schema.js';

/**
 * Acesso às tabelas da 015 (lead, fluxo_sdr, proposta_sdr). Interface
 * explícita para o fluxo poder receber um stub nos testes de unidade.
 */

export type LeadRow = typeof lead.$inferSelect;
export type FluxoSdrRow = typeof fluxoSdr.$inferSelect;
export type PropostaSdrRow = typeof propostaSdr.$inferSelect;
type NovaProposta = typeof propostaSdr.$inferInsert;

export interface SdrRepo {
  fluxoAtivo(conversaId: string): Promise<FluxoSdrRow | null>;
  /**
   * 015b: o último fluxo da conversa, ATIVO OU NÃO. A decisão do console parte
   * de um fluxo `encerrado:aguardando_aprovacao` — `fluxoAtivo` o esconde de
   * propósito (ele não deve consumir turno), mas é exatamente ele que o
   * atendente está decidindo.
   */
  fluxoDaConversa(conversaId: string): Promise<(FluxoSdrRow & { waId: string | null }) | null>;
  /** Lead por wa_id; cria como `novo` se não existir. */
  garantirLead(waId: string, conversaId: string, traceId: string): Promise<LeadRow>;
  atualizarLead(
    id: string,
    patch: Partial<Pick<LeadRow, 'nome' | 'perfil' | 'status'>>,
  ): Promise<void>;
  propostasHoje(conversaId: string): Promise<number>;
  propostaAbertaPorReferencia(referencia: string): Promise<PropostaSdrRow | null>;
  criarProposta(valores: NovaProposta): Promise<PropostaSdrRow>;
  atualizarProposta(
    id: string,
    patch: Partial<
      Pick<
        PropostaSdrRow,
        'valorOfertadoCentavos' | 'descontoBps' | 'valorPedidoCentavos' | 'status' | 'motivo'
      >
    >,
  ): Promise<void>;
}

export function createSdrRepo(db: Db): SdrRepo {
  return {
    async fluxoAtivo(conversaId) {
      const [f] = await db
        .select()
        .from(fluxoSdr)
        .where(and(eq(fluxoSdr.conversaId, conversaId), ne(fluxoSdr.etapa, 'encerrado')))
        .limit(1);
      return f ?? null;
    },

    async fluxoDaConversa(conversaId) {
      const [f] = await db
        .select({ fluxo: fluxoSdr, waId: lead.waId })
        .from(fluxoSdr)
        .innerJoin(lead, eq(lead.id, fluxoSdr.leadId))
        .where(eq(fluxoSdr.conversaId, conversaId))
        .orderBy(desc(fluxoSdr.criadoEm))
        .limit(1);
      return f ? { ...f.fluxo, waId: f.waId } : null;
    },

    async garantirLead(waId, conversaId, traceId) {
      const [existente] = await db.select().from(lead).where(eq(lead.waId, waId));
      if (existente) return existente;
      const [criado] = await db
        .insert(lead)
        .values({ id: traceId, waId, conversaId, origem: 'inbound', status: 'novo', traceId })
        .onConflictDoNothing({ target: lead.waId })
        .returning();
      if (criado) return criado;
      const [denovo] = await db.select().from(lead).where(eq(lead.waId, waId));
      if (!denovo) throw new Error(`lead ${waId} não encontrado após upsert`);
      return denovo;
    },

    async atualizarLead(id, patch) {
      await db
        .update(lead)
        .set({ ...patch, atualizadoEm: new Date() })
        .where(eq(lead.id, id));
    },

    async propostasHoje(conversaId) {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(propostaSdr)
        .where(
          and(
            eq(propostaSdr.conversaId, conversaId),
            sql`${propostaSdr.criadoEm} >= date_trunc('day', now())`,
          ),
        );
      return r?.n ?? 0;
    },

    async propostaAbertaPorReferencia(referencia) {
      const [p] = await db
        .select()
        .from(propostaSdr)
        .where(
          and(
            eq(propostaSdr.referencia, referencia),
            inArray(propostaSdr.status, [...STATUS_PROPOSTA_SDR_ABERTA]),
          ),
        )
        .orderBy(desc(propostaSdr.criadoEm))
        .limit(1);
      return p ?? null;
    },

    async criarProposta(valores) {
      const [p] = await db.insert(propostaSdr).values(valores).returning();
      if (!p) throw new Error('insert de proposta sem retorno');
      return p;
    },

    async atualizarProposta(id, patch) {
      await db
        .update(propostaSdr)
        .set({ ...patch, atualizadoEm: new Date() })
        .where(eq(propostaSdr.id, id));
    },
  };
}
