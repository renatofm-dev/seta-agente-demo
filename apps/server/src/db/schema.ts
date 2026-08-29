import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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

/** Sinais para o loop de aprendizado (009: o distiller consome e marca processado). */
export const sinalAprendizado = pgTable('sinal_aprendizado', {
  id: uuid('id').primaryKey(),
  tipo: text('tipo', {
    // verdict_guardrail: nome da spec 009 (#36); rejeicao_proposta: feedback do
    // curador — auditável, mas FORA do clustering do distiller
    enum: [
      'correcao_hitl',
      'verdict_guardrail',
      'escalonamento',
      'resolucao_limpa',
      're_pergunta',
      'rejeicao_proposta',
    ],
  }).notNull(),
  ticketId: uuid('ticket_id').references(() => ticket.id),
  conversaId: uuid('conversa_id')
    .notNull()
    .references(() => conversa.id),
  payload: jsonb('payload').notNull(),
  processadoEm: timestamp('processado_em', { withTimezone: true }),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

// --- Skills + loop de aprendizado (009) ------------------------------------

export const skill = pgTable('skill', {
  id: uuid('id').primaryKey(),
  idLogico: text('id_logico').notNull().unique(), // name kebab-case do SKILL.md
  escopo: text('escopo').notNull().default('local'),
  forkDe: uuid('fork_de'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Versões IMUTÁVEIS: aprovar edição cria versão nova; só uma `ativa` por skill. */
export const skillVersao = pgTable(
  'skill_versao',
  {
    id: uuid('id').primaryKey(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skill.id),
    versao: integer('versao').notNull(),
    corpo: text('corpo').notNull(),
    frontmatter: jsonb('frontmatter').notNull(),
    status: text('status', {
      enum: ['proposta', 'em_revisao', 'ativa', 'arquivada', 'rejeitada'],
    }).notNull(),
    criadoPor: text('criado_por', { enum: ['distiller', 'humano'] }).notNull(),
    aprovadoPor: text('aprovado_por'),
    aprovadoEm: timestamp('aprovado_em', { withTimezone: true }),
    propostaId: uuid('proposta_id'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('skill_versao_skill_versao_unique').on(t.skillId, t.versao)],
);

export const proposta = pgTable('proposta', {
  id: uuid('id').primaryKey(),
  tipo: text('tipo', {
    enum: ['skill_novo', 'skill_patch', 'exemplar', 'lacuna_kb', 'lacuna_catalogo'],
  }).notNull(),
  skillId: uuid('skill_id').references(() => skill.id),
  /** Para skill_novo o diff é o corpo inteiro proposto. */
  diff: text('diff').notNull(),
  frontmatter: jsonb('frontmatter').notNull(),
  evidencia: jsonb('evidencia').notNull(), // métricas do cluster + trechos
  sinais: jsonb('sinais').notNull(), // uuid[] dos sinais de origem
  status: text('status', { enum: ['aberta', 'aprovada', 'rejeitada'] })
    .notNull()
    .default('aberta'),
  motivoRejeicao: text('motivo_rejeicao'),
  revisadoPor: text('revisado_por'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Caso de avaliação extraído do trace real (toda proposta gera um). */
export const casoEval = pgTable('caso_eval', {
  id: uuid('id').primaryKey(),
  input: text('input').notNull(),
  comportamentoEsperado: text('comportamento_esperado').notNull(),
  origem: jsonb('origem').notNull(), // { propostaId, traceTurnoId? }
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

// --- RAG (008): documentos e chunks no pgvector ----------------------------

/**
 * `vector` SEM dimensão fixa: a dimensão vem do env (EMBEDDING_DIM), validada
 * no store; o índice HNSW é de expressão (cast p/ vector(D)) criado em runtime.
 */
const vetor = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value) {
    return JSON.parse(value) as number[];
  },
});

/** Bookkeeping da ingestão da KB: hash decide re-embedar; versão incrementa. */
export const documento = pgTable(
  'documento',
  {
    id: uuid('id').primaryKey(),
    ns: text('ns', { enum: ['kb', 'skills'] }).notNull(),
    fonte: text('fonte').notNull(), // path relativo do .md
    titulo: text('titulo').notNull(), // nome amigável (H1) — é o que o agente cita
    hash: text('hash').notNull(), // sha256 do conteúdo
    versao: integer('versao').notNull().default(1),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('documento_ns_fonte_unique').on(t.ns, t.fonte)],
);

/** Unidade de retrieval; tsv (tsvector generated, na migration) dá a busca lexical. */
export const chunk = pgTable(
  'chunk',
  {
    id: uuid('id').primaryKey(),
    ns: text('ns', { enum: ['kb', 'skills'] }).notNull(),
    documentoId: uuid('documento_id').references(() => documento.id, { onDelete: 'cascade' }),
    fonte: text('fonte').notNull(),
    titulo: text('titulo'),
    seq: integer('seq').notNull().default(0),
    texto: text('texto').notNull(),
    metadados: jsonb('metadados').notNull().default({}),
    embedding: vetor('embedding'), // null ⇒ participa só da busca lexical
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chunk_ns_idx').on(t.ns), index('chunk_documento_idx').on(t.documentoId)],
);

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

// --- Observabilidade (010): eventos tipados por turno ----------------------
// Sem FKs de propósito: escrita assíncrona nunca pode travar limpeza/turno.

export const eventoLlm = pgTable('evento_llm', {
  id: uuid('id').primaryKey(),
  traceId: text('trace_id').notNull(),
  // nullable (#30): distiller gasta tokens fora de qualquer conversa
  conversaId: uuid('conversa_id'),
  turnoId: uuid('turno_id'),
  ticketId: uuid('ticket_id'),
  modelo: text('modelo').notNull(),
  tokensEntrada: integer('tokens_entrada').notNull(),
  tokensSaida: integer('tokens_saida').notNull(),
  latenciaMs: integer('latencia_ms').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const eventoGuardrail = pgTable('evento_guardrail', {
  id: uuid('id').primaryKey(),
  traceId: text('trace_id').notNull(),
  conversaId: uuid('conversa_id').notNull(),
  turnoId: uuid('turno_id'),
  ticketId: uuid('ticket_id'),
  guardrail: text('guardrail').notNull(), // preco, classificador_intencao, ...
  hook: text('hook', { enum: ['beforeTool', 'afterTool', 'beforeReply'] }).notNull(),
  verdict: text('verdict', { enum: ['allow', 'rewrite', 'block', 'escalate'] }).notNull(),
  motivo: text('motivo'),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const eventoEscalonamento = pgTable('evento_escalonamento', {
  id: uuid('id').primaryKey(),
  traceId: text('trace_id').notNull(),
  conversaId: uuid('conversa_id').notNull(),
  turnoId: uuid('turno_id'),
  ticketId: uuid('ticket_id'),
  motivo: text('motivo').notNull(), // trigger: negociacao_preco, tema_sensivel, ...
  origem: text('origem', {
    enum: ['guardrail', 'intencao', 'agente', 'falha_tool', 'erro'],
  }).notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});
