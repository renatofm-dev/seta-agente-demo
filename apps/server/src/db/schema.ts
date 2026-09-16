import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
  /**
   * #46: turnos seguidos descartados por mensagem nova em voo. No teto, o
   * agente responde mesmo com pendência (anti-inanição); zera a cada envio.
   */
  descartesConsecutivos: integer('descartes_consecutivos').notNull().default(0),
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
  /** Quem produziu a mensagem: contato (in); bot, atendente ou campanha/013 (out). */
  autor: text('autor', { enum: ['contato', 'bot', 'atendente', 'campanha'] })
    .notNull()
    .default('contato'),
  /** #45: qual atendente falou (user.id) — atribuição por mensagem na thread. */
  atendenteId: text('atendente_id'),
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
  /** #45: atendente autor da resposta manual (propagado à mensagem no envio). */
  atendenteId: text('atendente_id'),
  texto: text('texto').notNull(),
  /**
   * 043: template equivalente a este texto, alternativa quando a janela de 24h
   * fecha. Nulo ⇒ comportamento da 014 (marca `janela_fechada` + ticket).
   */
  template: jsonb('template'),
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

/**
 * #45: marca de leitura POR ATENDENTE — não-lidas = mensagens `in` da conversa
 * com criado_em > lida_ate do usuário (sem linha ⇒ tudo conta como não lido).
 */
export const conversaLeitura = pgTable(
  'conversa_leitura',
  {
    conversaId: uuid('conversa_id')
      .notNull()
      .references(() => conversa.id),
    userId: text('user_id').notNull(),
    lidaAte: timestamp('lida_ate', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversaId, t.userId] })],
);

/** Contato WhatsApp com vínculo verificado ao cliente do ERP (seed na POC — corte da 000). */
export const contato = pgTable('contato', {
  id: uuid('id').primaryKey(),
  waId: text('wa_id').notNull().unique(),
  nome: text('nome'),
  clienteErpId: text('cliente_erp_id').notNull(),
  /**
   * 014: CPF/CNPJ do titular (só dígitos) — o PSP exige documento e o ERP não
   * o expõe ao papel de leitura (LGPD). Vem do vínculo verificado; sem ele o
   * fluxo de pagamento bloqueia e escala.
   */
  documento: text('documento'),
  verificadoEm: timestamp('verificado_em', { withTimezone: true }).notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

// --- Disparos de template para a carteira (013) ----------------------------

/** Espelho local do template do WABA; o status de aprovação vem da Meta (sync). */
export const modeloMensagem = pgTable('modelo_mensagem', {
  id: uuid('id').primaryKey(),
  nome: text('nome').notNull().unique(), // ^[a-z0-9_]+$ (regra da Meta)
  idioma: text('idioma').notNull().default('pt_BR'),
  categoria: text('categoria', { enum: ['utility', 'marketing'] })
    .notNull()
    .default('utility'),
  corpo: text('corpo').notNull(), // variáveis posicionais {{1}}..{{N}}
  rodape: text('rodape'),
  metaId: text('meta_id'),
  statusMeta: text('status_meta', {
    enum: ['pendente', 'aprovado', 'rejeitado', 'desconhecido'],
  })
    .notNull()
    .default('pendente'),
  motivoRejeicao: text('motivo_rejeicao'),
  criadoPor: text('criado_por').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Um disparo = 1 modelo aprovado + valores de variáveis + N destinatários. */
export const disparo = pgTable('disparo', {
  id: uuid('id').primaryKey(),
  modeloId: uuid('modelo_id')
    .notNull()
    .references(() => modeloMensagem.id),
  /** Valores das variáveis {{1}}..{{N}}, globais ao disparo (013). */
  variaveis: jsonb('variaveis').notNull().default([]),
  /** 017: rótulo humano da campanha; ausente ⇒ nome do modelo. */
  nome: text('nome'),
  /** 017: meta de conversão (pagas ÷ entregues) em bps; ausente ⇒ global do client.yaml. */
  metaConversaoBps: integer('meta_conversao_bps'),
  status: text('status', { enum: ['enviando', 'concluido'] })
    .notNull()
    .default('enviando'),
  criadoPor: text('criado_por').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const disparoDestinatario = pgTable(
  'disparo_destinatario',
  {
    id: uuid('id').primaryKey(),
    disparoId: uuid('disparo_id')
      .notNull()
      .references(() => disparo.id),
    waId: text('wa_id').notNull(),
    /** Snapshot do nome do contato no momento do disparo (exibição). */
    contatoNome: text('contato_nome'),
    status: text('status', { enum: ['pendente', 'enviado', 'entregue', 'lido', 'falha'] })
      .notNull()
      .default('pendente'),
    waMessageId: text('wa_message_id').unique(),
    erro: text('erro'),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('disparo_destinatario_disparo_idx').on(t.disparoId)],
);

// --- Cobrança e pagamento pelo WhatsApp (014) --------------------------------

export const METODOS_COBRANCA = ['boleto', 'pix', 'cartao'] as const;
export const STATUS_COBRANCA = [
  'aguardando_aprovacao',
  'emitindo',
  'emitida',
  'paga',
  'expirada',
  'cancelada',
  'recusada',
  'falha',
  'estornada',
] as const;
export type StatusCobranca = (typeof STATUS_COBRANCA)[number];
/** Cobrança "aberta": pode virar paga e bloqueia uma segunda com a mesma referência. */
export const STATUS_COBRANCA_ABERTA: readonly StatusCobranca[] = [
  'aguardando_aprovacao',
  'emitindo',
  'emitida',
];

/**
 * Estado do fluxo de cobrança por conversa (máquina de estados do
 * @seta/cobranca). `candidatos` é o snapshot dos títulos listados — as
 * escolhas do cliente referem-se a ele, não a uma releitura do ERP.
 */
export const fluxoCobranca = pgTable(
  'fluxo_cobranca',
  {
    id: uuid('id').primaryKey(),
    conversaId: uuid('conversa_id')
      .notNull()
      .references(() => conversa.id),
    contratoId: text('contrato_id').notNull(),
    etapa: text('etapa', { enum: ['selecao', 'metodo', 'confirmacao', 'encerrado'] }).notNull(),
    encerramento: text('encerramento'),
    candidatos: jsonb('candidatos').notNull(),
    selecao: jsonb('selecao').notNull().default([]),
    metodo: text('metodo', { enum: METODOS_COBRANCA }),
    naoEntendi: integer('nao_entendi').notNull().default(0),
    cobrancaId: uuid('cobranca_id'),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 1 fluxo ativo por conversa
    uniqueIndex('fluxo_cobranca_ativo_uq').on(t.conversaId).where(sql`etapa <> 'encerrado'`),
  ],
);

/** A cobrança no PSP (1 por conjunto de parcelas); o dinheiro é sempre em centavos. */
export const cobranca = pgTable(
  'cobranca',
  {
    id: uuid('id').primaryKey(),
    conversaId: uuid('conversa_id')
      .notNull()
      .references(() => conversa.id),
    contratoId: text('contrato_id').notNull(),
    /** `contrato:{id}:titulos:{ids}` — chave de idempotência no PSP. */
    referenciaExterna: text('referencia_externa').notNull(),
    status: text('status', { enum: STATUS_COBRANCA }).notNull(),
    metodo: text('metodo', { enum: METODOS_COBRANCA }).notNull(),
    valorCentavos: integer('valor_centavos').notNull(),
    /** Vencimento da cobrança no PSP (hoje + N dias), não o da parcela. */
    vencimentoPsp: date('vencimento_psp', { mode: 'string' }).notNull(),
    psp: text('psp').notNull(), // asaas | simulado
    pspClienteId: text('psp_cliente_id'),
    pspCobrancaId: text('psp_cobranca_id'),
    urlFatura: text('url_fatura'),
    urlBoleto: text('url_boleto'),
    linhaDigitavel: text('linha_digitavel'),
    pixCopiaCola: text('pix_copia_cola'),
    pixExpiraEm: text('pix_expira_em'),
    /** Motivo de bloqueio, falha ou recusa (humano-legível). */
    motivo: text('motivo'),
    aprovadoPor: text('aprovado_por'),
    aprovadoEm: timestamp('aprovado_em', { withTimezone: true }),
    pagoEm: timestamp('pago_em', { withTimezone: true }),
    tentativas: integer('tentativas').notNull().default(0),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // pedir duas vezes as mesmas parcelas não cria duas cobranças abertas
    uniqueIndex('cobranca_referencia_aberta_uq')
      .on(t.referenciaExterna)
      .where(sql`status IN ('aguardando_aprovacao', 'emitindo', 'emitida')`),
    index('cobranca_psp_idx').on(t.pspCobrancaId),
    index('cobranca_contrato_idx').on(t.contratoId, t.criadoEm),
    index('cobranca_conversa_idx').on(t.conversaId, t.criadoEm),
  ],
);

/** Parcelas (títulos do ERP) cobertas pela cobrança — a baixa é por título. */
export const cobrancaTitulo = pgTable(
  'cobranca_titulo',
  {
    cobrancaId: uuid('cobranca_id')
      .notNull()
      .references(() => cobranca.id),
    tituloId: text('titulo_id').notNull(),
    origem: text('origem', { enum: ['entrada', 'saldo'] }).notNull(),
    parcela: integer('parcela').notNull(),
    totalParcelas: integer('total_parcelas'),
    valorCentavos: integer('valor_centavos').notNull(),
    /** Vencimento original da parcela no ERP. */
    vencimento: date('vencimento', { mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.cobrancaId, t.tituloId] })],
);

// --- SDR para lead frio (015) --------------------------------------------------

export const STATUS_LEAD = [
  'novo',
  'qualificando',
  'qualificado',
  'proposta',
  'agendado',
  'perdido',
] as const;
export const STATUS_PROPOSTA_SDR = [
  'rascunho',
  'ofertada',
  'aguardando_aprovacao',
  'aceita',
  'recusada',
  'expirada',
] as const;
export type StatusPropostaSdr = (typeof STATUS_PROPOSTA_SDR)[number];
/** Proposta "aberta": bloqueia uma segunda para o mesmo lead×cota. */
export const STATUS_PROPOSTA_SDR_ABERTA: readonly StatusPropostaSdr[] = [
  'ofertada',
  'aguardando_aprovacao',
];

/** Lead NÃO existe no ERP até virar contrato — mora aqui. `perfil` é o jsonb da qualificação. */
export const lead = pgTable(
  'lead',
  {
    id: uuid('id').primaryKey(),
    waId: text('wa_id').notNull(),
    nome: text('nome'),
    origem: text('origem').notNull().default('inbound'),
    perfil: jsonb('perfil').notNull().default({}),
    status: text('status', { enum: STATUS_LEAD }).notNull().default('novo'),
    conversaId: uuid('conversa_id').references(() => conversa.id),
    traceId: text('trace_id'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('lead_wa_id_uq').on(t.waId)],
);

/** Estado do fluxo SDR por conversa (máquina do @seta/sdr). `opcoes` é o snapshot apresentado. */
export const fluxoSdr = pgTable(
  'fluxo_sdr',
  {
    id: uuid('id').primaryKey(),
    conversaId: uuid('conversa_id')
      .notNull()
      .references(() => conversa.id),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => lead.id),
    etapa: text('etapa', {
      enum: ['qualificacao', 'apresentacao', 'oferta', 'agendamento', 'encerrado'],
    }).notNull(),
    encerramento: text('encerramento'),
    perfil: jsonb('perfil').notNull().default({}),
    opcoes: jsonb('opcoes').notNull().default([]),
    escolha: integer('escolha'),
    oferta: text('oferta', { enum: ['tabela', 'piso'] }),
    naoEntendi: integer('nao_entendi').notNull().default(0),
    propostaId: uuid('proposta_id'),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 1 fluxo ativo por conversa
    uniqueIndex('fluxo_sdr_ativo_uq').on(t.conversaId).where(sql`etapa <> 'encerrado'`),
  ],
);

/**
 * Proposta feita ao lead — gravada ANTES de ser enviada. É a trilha de
 * auditoria e a fonte de verdade da alçada: tabela, piso e o que foi ofertado,
 * sempre em centavos; `valor_pedido_centavos` é o que o lead pediu quando
 * escalou.
 */
export const propostaSdr = pgTable(
  'proposta_sdr',
  {
    id: uuid('id').primaryKey(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => lead.id),
    fluxoId: uuid('fluxo_id').references(() => fluxoSdr.id),
    conversaId: uuid('conversa_id')
      .notNull()
      .references(() => conversa.id),
    cotaId: text('cota_id').notNull(),
    cotaCodigo: text('cota_codigo').notNull(),
    /** `lead:{waId}:cota:{cotaId}` — uma proposta aberta por lead×cota. */
    referencia: text('referencia').notNull(),
    valorTabelaCentavos: integer('valor_tabela_centavos').notNull(),
    valorMinimoCentavos: integer('valor_minimo_centavos').notNull(),
    valorOfertadoCentavos: integer('valor_ofertado_centavos').notNull(),
    descontoBps: integer('desconto_bps').notNull().default(0),
    valorPedidoCentavos: integer('valor_pedido_centavos'),
    status: text('status', { enum: STATUS_PROPOSTA_SDR }).notNull(),
    motivo: text('motivo'),
    aprovadoPor: text('aprovado_por'),
    aprovadoEm: timestamp('aprovado_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('proposta_sdr_referencia_aberta_uq')
      .on(t.referencia)
      .where(sql`status IN ('ofertada', 'aguardando_aprovacao')`),
    index('proposta_sdr_conversa_idx').on(t.conversaId, t.criadoEm),
    index('proposta_sdr_lead_idx').on(t.leadId, t.criadoEm),
  ],
);

/**
 * Espelho da baixa que o ERP faria (o ERP é read-only por desenho): 1 linha por
 * título recebido. A camada de conciliação (pagamentos/conciliacao.ts) faz as
 * leituras `financeiro.*` refletirem estas linhas.
 */
export const pagamento = pgTable(
  'pagamento',
  {
    id: uuid('id').primaryKey(),
    contratoId: text('contrato_id').notNull(),
    tituloId: text('titulo_id').notNull(),
    cobrancaId: uuid('cobranca_id')
      .notNull()
      .references(() => cobranca.id),
    valorCentavos: integer('valor_centavos').notNull(),
    metodo: text('metodo', { enum: METODOS_COBRANCA }).notNull(),
    recebidoEm: timestamp('recebido_em', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['confirmado', 'estornado'] })
      .notNull()
      .default('confirmado'),
    eventoPspId: text('evento_psp_id'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pagamento_cobranca_titulo_uq').on(t.cobrancaId, t.tituloId),
    index('pagamento_contrato_idx').on(t.contratoId, t.status),
  ],
);

/** Eventos do webhook do PSP — id do evento como PK = idempotência da reentrega. */
export const eventoPsp = pgTable(
  'evento_psp',
  {
    id: text('id').primaryKey(),
    psp: text('psp').notNull(),
    tipo: text('tipo').notNull(),
    pspCobrancaId: text('psp_cobranca_id'),
    payload: jsonb('payload').notNull(),
    recebidoEm: timestamp('recebido_em', { withTimezone: true }).notNull().defaultNow(),
    processadoEm: timestamp('processado_em', { withTimezone: true }),
    erro: text('erro'),
  },
  (t) => [index('evento_psp_cobranca_idx').on(t.pspCobrancaId)],
);

/** Cliente do contrato no PSP (criado uma vez, reaproveitado). */
export const pspCliente = pgTable(
  'psp_cliente',
  {
    psp: text('psp').notNull(),
    contratoId: text('contrato_id').notNull(),
    pspClienteId: text('psp_cliente_id').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.psp, t.contratoId] })],
);

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
    // curador — auditável, mas FORA do clustering do distiller;
    // feedback_atendente: 👍/👎 do atendente sobre um turno (console › Aprendizado)
    enum: [
      'correcao_hitl',
      'verdict_guardrail',
      'escalonamento',
      'resolucao_limpa',
      're_pergunta',
      'rejeicao_proposta',
      'feedback_atendente',
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

/**
 * 036 — razão das ESCRITAS no ERP. Uma linha por operação, chave determinística
 * (`baixa:<pagamento.id>`), e é ela que sustenta as quatro camadas de
 * idempotência: `TransacaoEletronica` quase certamente não é idempotente no
 * TSE, e o webhook do Asaas reentrega enquanto o pg-boss re-tenta.
 *
 * Também é o que faz a conciliação da 014 virar compensação: enquanto a linha
 * não está `confirmada`, o decorator ainda compensa; depois, a verdade é do ERP.
 */
export const OPERACOES_ERP = ['baixa', 'reserva', 'lead', 'venda'] as const;
export const ESTADOS_ERP_ESCRITA = ['pendente', 'confirmada', 'falha'] as const;

export const erpEscrita = pgTable(
  'erp_escrita',
  {
    /** `<operacao>:<id local>` — determinística, e é a PK: repetir não duplica. */
    chave: text('chave').primaryKey(),
    operacao: text('operacao', { enum: OPERACOES_ERP }).notNull(),
    /** idcontafinanceira, idcontrato — o alvo no ERP, para auditoria e suporte. */
    alvo: text('alvo').notNull(),
    payload: jsonb('payload').notNull(),
    estado: text('estado', { enum: ESTADOS_ERP_ESCRITA }).notNull().default('pendente'),
    /** Id devolvido pelo TSE (a transação eletrônica), quando confirmada. */
    erpId: text('erp_id'),
    tentativas: integer('tentativas').notNull().default(0),
    erro: text('erro'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('erp_escrita_estado_idx').on(t.estado, t.operacao)],
);
