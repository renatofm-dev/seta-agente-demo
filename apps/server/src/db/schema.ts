import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Schema Drizzle do banco `app` (o produto). Demais tabelas chegam nas specs 005/007/009.
 * O schema do `erp_mock` NÃO vive aqui — é SQL puro em infra/erp-mock (spec 002),
 * porque o produto não é dono daquele banco.
 */

/** Conversa WhatsApp por contato (wa_id). Janela de 24h para resposta livre. */
export const conversa = pgTable('conversa', {
  id: uuid('id').primaryKey(), // UUIDv7 gerado na aplicação
  waId: text('wa_id').notNull().unique(),
  janelaExpiraEm: timestamp('janela_expira_em', { withTimezone: true }),
  /** Resumo rolante do histórico (atualizado a cada K turnos pelo runtime). */
  resumo: text('resumo'),
  turnosDesdeResumo: integer('turnos_desde_resumo').notNull().default(0),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Turno agregado pelo debouncer: 1..N mensagens do contato viram 1 processamento. */
export const turno = pgTable('turno', {
  id: uuid('id').primaryKey(),
  conversaId: uuid('conversa_id')
    .notNull()
    .references(() => conversa.id),
  textoAgregado: text('texto_agregado').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Mensagens in/out. wa_message_id UNIQUE dá idempotência de reentrega do webhook. */
export const mensagem = pgTable('mensagem', {
  id: uuid('id').primaryKey(),
  conversaId: uuid('conversa_id')
    .notNull()
    .references(() => conversa.id),
  direcao: text('direcao', { enum: ['in', 'out'] }).notNull(),
  waMessageId: text('wa_message_id').unique(),
  texto: text('texto').notNull(),
  status: text('status', {
    enum: ['recebida', 'pendente', 'enviada', 'entregue', 'lida', 'falha'],
  }).notNull(),
  turnoId: uuid('turno_id').references(() => turno.id),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Outbox de saída: dedupe por turno+seq; worker envia via Graph API com retry. */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  conversaId: uuid('conversa_id')
    .notNull()
    .references(() => conversa.id),
  turnoId: uuid('turno_id')
    .notNull()
    .references(() => turno.id),
  seq: integer('seq').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(), // `${turnoId}:${seq}`
  texto: text('texto').notNull(),
  status: text('status', {
    enum: ['pendente', 'enviada', 'falha', 'janela_fechada'],
  })
    .notNull()
    .default('pendente'),
  tentativas: integer('tentativas').notNull().default(0),
  waMessageId: text('wa_message_id'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Trace completo do turno — persistido SEMPRE; reconstitui a decisão inteira (010). */
export const traceTurno = pgTable('trace_turno', {
  id: uuid('id').primaryKey(),
  turnoId: uuid('turno_id')
    .notNull()
    .references(() => turno.id),
  conversaId: uuid('conversa_id')
    .notNull()
    .references(() => conversa.id),
  traceId: text('trace_id').notNull(),
  /** Contexto montado: skills, resumo presente, tools disponíveis, nº de mensagens. */
  contexto: jsonb('contexto').notNull(),
  /** Eventos ordenados: llm, tool (params + resultado mascarado), verdicts, fallback. */
  eventos: jsonb('eventos').notNull(),
  resposta: text('resposta').notNull(),
  escalado: boolean('escalado').notNull(),
  fallback: boolean('fallback').notNull(),
  fallbackMotivo: text('fallback_motivo'),
  tokensEntrada: integer('tokens_entrada').notNull(),
  tokensSaida: integer('tokens_saida').notNull(),
  latenciaMs: integer('latencia_ms').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Auditoria de execuções do catálogo (gravada pelo executor; a 010 consome). */
export const eventoQuery = pgTable('evento_query', {
  id: uuid('id').primaryKey(), // UUIDv7 gerado na aplicação
  traceId: text('trace_id').notNull(),
  entryId: text('entry_id').notNull(),
  ok: boolean('ok').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  linhas: integer('linhas').notNull(),
  truncated: boolean('truncated').notNull(),
  erro: text('erro'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});
