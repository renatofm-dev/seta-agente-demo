import { newTraceId } from '@seta/observability';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { cobranca, contato, type StatusVenda, venda } from '../db/schema.js';

/**
 * Persistência da venda (045). Mesma forma do `reserva/repo.ts`: consultas
 * nomeadas, nada de SQL solto no fluxo, e o status é sempre transição
 * explícita — a venda é a coisa mais cara que o agente faz, e ninguém deve
 * precisar ler o fluxo inteiro para saber em que estado ela está.
 */

export type VendaRow = typeof venda.$inferSelect;

/** Estados em que a venda ainda "ocupa" a cota — casa com o índice único parcial. */
export const VENDA_VIVA: readonly StatusVenda[] = [
  'sinal_emitido',
  'sinal_pago',
  'registrando',
  'registrada',
];

export interface Comprador {
  readonly nome: string;
  readonly cpf: string;
}

export interface NovaVenda {
  readonly id: string;
  readonly conversaId: string;
  readonly leadId: string | null;
  readonly propostaId: string | null;
  readonly cobrancaId: string | null;
  readonly comprador: Comprador;
  readonly cotaId: string;
  readonly cotaCodigo: string;
  readonly idProduto: number;
  readonly valorCentavos: number;
  readonly sinalCentavos: number;
}

export interface VendaRepo {
  criar(v: NovaVenda): Promise<VendaRow>;
  porId(id: string): Promise<VendaRow | null>;
  porCobranca(cobrancaId: string): Promise<VendaRow | null>;
  daConversa(conversaId: string): Promise<VendaRow | null>;
  vivaPorCota(cotaId: string): Promise<VendaRow | null>;
  atualizar(id: string, campos: Partial<VendaRow>): Promise<void>;
  listar(filtro?: { status?: StatusVenda; conversaId?: string }): Promise<VendaRow[]>;
  /**
   * 045: o PSP exige documento para criar o cliente (`emitir.ts` recusa sem
   * ele). O CPF do lead frio chega aqui pela etapa `dados` e é gravado SEM
   * `cliente_erp_id`: o número continua sem vínculo, e a raia do SDR continua
   * valendo até a venda existir no ERP.
   */
  garantirContato(waId: string, c: Comprador): Promise<void>;
}

export function createVendaRepo(db: Db): VendaRepo {
  return {
    async criar(v) {
      const [linha] = await db
        .insert(venda)
        .values({ ...v, comprador: v.comprador, status: 'sinal_emitido' })
        .returning();
      return linha as VendaRow;
    },

    async porId(id) {
      const [linha] = await db.select().from(venda).where(eq(venda.id, id));
      return linha ?? null;
    },

    async porCobranca(cobrancaId) {
      const [linha] = await db.select().from(venda).where(eq(venda.cobrancaId, cobrancaId));
      return linha ?? null;
    },

    async daConversa(conversaId) {
      const [linha] = await db
        .select()
        .from(venda)
        .where(eq(venda.conversaId, conversaId))
        .orderBy(desc(venda.criadoEm))
        .limit(1);
      return linha ?? null;
    },

    async vivaPorCota(cotaId) {
      const [linha] = await db
        .select()
        .from(venda)
        .where(and(eq(venda.cotaId, cotaId), inArray(venda.status, [...VENDA_VIVA])));
      return linha ?? null;
    },

    async atualizar(id, campos) {
      await db
        .update(venda)
        .set({ ...campos, atualizadoEm: new Date() })
        .where(eq(venda.id, id));
    },

    async listar(filtro) {
      const onde = [
        ...(filtro?.status ? [eq(venda.status, filtro.status)] : []),
        ...(filtro?.conversaId ? [eq(venda.conversaId, filtro.conversaId)] : []),
      ];
      return db
        .select()
        .from(venda)
        .where(onde.length > 0 ? and(...onde) : undefined)
        .orderBy(desc(venda.criadoEm))
        .limit(200);
    },

    async garantirContato(waId, c) {
      await db
        .insert(contato)
        .values({
          id: newTraceId(),
          waId,
          nome: c.nome,
          documento: c.cpf,
          // vazio de propósito: lead frio NÃO tem contrato, e é isso que mantém
          // `clienteId === ''` e a raia do SDR valendo até a venda existir
          clienteErpId: '',
          verificadoEm: new Date(),
        })
        .onConflictDoUpdate({
          target: contato.waId,
          // não toca em cliente_erp_id: quem tem vínculo continua com o dele,
          // e o lead frio continua sem — é o que mantém as raias separadas
          set: { nome: c.nome, documento: c.cpf },
        });
    },
  };
}

/** Cobranças de venda da conversa, para o console mostrar o PIX junto. */
export async function cobrancaDaVenda(db: Db, cobrancaId: string | null) {
  if (!cobrancaId) return null;
  const [linha] = await db.select().from(cobranca).where(eq(cobranca.id, cobrancaId));
  return linha ?? null;
}
