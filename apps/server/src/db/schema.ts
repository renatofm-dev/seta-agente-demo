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
  /** Quem produziu a mensagem (007): contato (in), bot ou atendente (out). */
  autor: text('autor', { enum: ['contato', 'bot', 'atendente'] })
    .notNull()
    .default('contato'),
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
  /** null quando a origem é um atendente (resposta manual, sem turno). */
  turnoId: uuid('turno_id').references(() => turno.id),
  seq: integer('seq').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(), // `${turnoId}:${seq}` | `manual:${chave}`
  autor: text('autor', { enum: ['bot', 'atendente'] })
    .notNull()
    .default('bot'),
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

/** Contato WhatsApp com vínculo verificado ao cliente do ERP (seed na POC — corte da 000). */
export const contato = pgTable('contato', {
  id: uuid('id').primaryKey(),
  waId: text('wa_id').notNull().unique(),
  nome: text('nome'),
  clienteErpId: text('cliente_erp_id').notNull(),
  verificadoEm: timestamp('verificado_em', { withTimezone: true }).notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Ticket 1:1 com a conversa; a história vive em evento_ticket. */
export const ticket = pgTable('ticket', {
  id: uuid('id').primaryKey(),
  conversaId: uuid('conversa_id')
    .notNull()
    .unique()
    .references(() => conversa.id),
  status: text('status', {
    enum: ['bot_ativo', 'aguardando_humano', 'humano_ativo', 'resolvido'],
  })
    .notNull()
    .default('bot_ativo'),
  atendenteId: text('atendente_id'),
  motivoEscalonamento: text('motivo_escalonamento'),
  escaladoEm: timestamp('escalado_em', { withTimezone: true }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Toda transição de ticket, com ator — trilha de auditoria do HITL. */
export const eventoTicket = pgTable('evento_ticket', {
  id: uuid('id').primaryKey(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => ticket.id),
  deStatus: text('de_status').notNull(),
  paraStatus: text('para_status').notNull(),
  ator: text('ator').notNull(), // sistema | bot | contato | atendente
  atorId: text('ator_id'),
  motivo: text('motivo'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Sinais para o loop de aprendizado (009 consome). */
export const sinalAprendizado = pgTable('sinal_aprendizado', {
  id: uuid('id').primaryKey(),
  tipo: text('tipo', { enum: ['correcao_hitl'] }).notNull(),
  ticketId: uuid('ticket_id').references(() => ticket.id),
  conversaId: uuid('conversa_id')
    .notNull()
    .references(() => conversa.id),
  payload: jsonb('payload').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

// --- Better Auth (007): tabelas padrão + campo role -----------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role', { enum: ['atendente', 'curador'] })
    .notNull()
    .default('atendente'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
