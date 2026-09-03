/**
 * Cliente fino da API do console (REST do Better Auth + /api/console/*).
 * Sem SDK: fetch same-origin via rewrite do Next — cookies incluídos.
 */

export interface Sessao {
  userId: string;
  nome: string;
  email: string;
  role: 'atendente' | 'curador';
}

export interface TicketResumo {
  id: string;
  conversaId: string;
  status: 'bot_ativo' | 'aguardando_humano' | 'humano_ativo' | 'resolvido';
  atendenteId: string | null;
  motivoEscalonamento: string | null;
  esperaSegundos: number | null;
  waId: string | null;
  contatoNome: string | null;
  clienteErpId: string | null;
  ultimaMensagem: { texto: string; autor: string; em: string } | null;
}

export interface Inbox {
  botAtivo: TicketResumo[];
  aguardando: TicketResumo[];
  meus: TicketResumo[];
}

export interface MensagemTicket {
  id: string;
  autor: 'contato' | 'bot' | 'atendente';
  texto: string;
  status: string;
  criadoEm: string;
}

export interface TicketDetalhe extends TicketResumo {
  mensagens: MensagemTicket[];
  perfilErp: Record<string, unknown> | null;
}

// --- Atendimento centrado em conversa (#45) --------------------------------

export type StatusTicket = TicketResumo['status'];
export type FiltroConversas = 'todas' | 'aguardando' | 'minhas' | 'resolvidas';

export interface ConversaResumo {
  conversaId: string;
  waId: string;
  contatoNome: string | null;
  clienteErpId: string | null;
  ticketId: string | null;
  status: StatusTicket;
  atendenteId: string | null;
  atendenteNome: string | null;
  motivoEscalonamento: string | null;
  esperaSegundos: number | null;
  janelaExpiraEm: string | null;
  naoLidas: number;
  ultimaMensagem: { texto: string; autor: string; em: string } | null;
}

export interface MensagemThread {
  id: string;
  autor: 'contato' | 'bot' | 'atendente' | 'campanha';
  atendenteId: string | null;
  atendenteNome: string | null;
  texto: string;
  status: 'recebida' | 'pendente' | 'enviada' | 'entregue' | 'lida' | 'falha';
  criadoEm: string;
}

export interface ConversaDetalhe {
  conversaId: string;
  waId: string;
  contatoNome: string | null;
  clienteErpId: string | null;
  janelaExpiraEm: string | null;
  limiteResposta: number;
  ticket: {
    id: string;
    status: StatusTicket;
    atendenteId: string | null;
    atendenteNome: string | null;
    motivoEscalonamento: string | null;
    esperaSegundos: number | null;
  };
  mensagens: MensagemThread[];
  temMais: boolean;
  perfilErp: Record<string, unknown> | null;
}

export interface PaginaMensagens {
  mensagens: MensagemThread[];
  temMais: boolean;
}

// --- Disparos de template (013) --------------------------------------------

export interface Modelo {
  id: string;
  nome: string;
  idioma: string;
  categoria: 'utility' | 'marketing';
  corpo: string;
  rodape: string | null;
  statusMeta: 'pendente' | 'aprovado' | 'rejeitado' | 'desconhecido';
  motivoRejeicao: string | null;
  criadoEm: string;
}

export interface ContatoCarteira {
  waId: string;
  nome: string | null;
  clienteErpId: string;
}

export interface DisparoResumo {
  id: string;
  status: 'enviando' | 'concluido';
  variaveis: string[];
  criado_em: string;
  modelo_nome: string;
  total: number;
  enviados: number;
  entregues: number;
  lidos: number;
  falhas: number;
  pendentes: number;
}

export interface DisparoDestinatarioView {
  id: string;
  waId: string;
  contatoNome: string | null;
  status: 'pendente' | 'enviado' | 'entregue' | 'lido' | 'falha';
  erro: string | null;
}

// --- Observabilidade (010) -------------------------------------------------

export type TraceEvento =
  | { tipo: 'contexto'; [k: string]: unknown }
  | {
      tipo: 'llm';
      tokensEntrada?: number;
      tokensSaida?: number;
      finishReason?: string;
      [k: string]: unknown;
    }
  | {
      tipo: 'tool';
      nome: string;
      params: Record<string, unknown>;
      resultado: unknown;
      latencyMs: number;
      erro?: string;
    }
  | {
      tipo: 'verdict';
      guardrail: string;
      hook: string;
      verdict: { tipo: string; trigger?: string; reason?: string; patch?: string };
    }
  | { tipo: 'fallback'; motivo: string }
  | { tipo: 'escalado' }
  | { tipo: 'descartado'; motivo: string };

export interface TraceTurnoView {
  id: string;
  traceId: string;
  turnoId: string;
  textoTurno: string | null;
  contexto: Record<string, unknown>;
  eventos: TraceEvento[];
  resposta: string;
  escalado: boolean;
  fallback: boolean;
  fallbackMotivo: string | null;
  tokensEntrada: number;
  tokensSaida: number;
  latenciaMs: number;
  criadoEm: string;
}

export interface Metricas {
  dias: 7 | 30;
  conversasPorDia: { dia: string; conversas: number }[];
  tokensPorDia: { dia: string; entrada: number; saida: number; custo: number }[];
  escalonamentosPorMotivo: { motivo: string; total: number }[];
  totalConversas: number;
  totalEscaladas: number;
  taxaResolucaoSemHumano: number | null;
  p95QueryMs: number | null;
  p95TurnoMs: number | null;
  custoTotal: number;
}

/** 014: cobrança gerada pelo fluxo de pagamento (espelho de /api/console/cobrancas). */
export type StatusCobranca =
  | 'aguardando_aprovacao'
  | 'emitindo'
  | 'emitida'
  | 'paga'
  | 'expirada'
  | 'cancelada'
  | 'recusada'
  | 'falha'
  | 'estornada';

export interface CobrancaView {
  id: string;
  conversaId: string;
  contratoId: string;
  status: StatusCobranca;
  metodo: 'boleto' | 'pix' | 'cartao';
  valorCentavos: number;
  vencimentoPsp: string;
  psp: string;
  pspCobrancaId: string | null;
  urlFatura: string | null;
  urlBoleto: string | null;
  motivo: string | null;
  aprovadoPor: string | null;
  pagoEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
  waId: string;
  contatoNome: string | null;
  ticketId: string | null;
  parcelas: string | null;
}

export interface CobrancasResposta {
  psp: string;
  ambiente: string;
  simuladorAtivo: boolean;
  contagens: Partial<Record<StatusCobranca, number>>;
  cobrancas: CobrancaView[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => fetch('/api/auth/sign-out', { method: 'POST' }),
  me: async (): Promise<Sessao | null> => {
    const res = await fetch('/api/console/me');
    return res.ok ? (res.json() as Promise<Sessao>) : null;
  },
  inbox: () => fetch('/api/console/inbox').then((r) => json<Inbox>(r)),
  conversas: (filtro: FiltroConversas, q: string) => {
    const params = new URLSearchParams({ filtro });
    if (q.trim()) params.set('q', q.trim());
    return fetch(`/api/console/conversas?${params}`).then((r) =>
      json<{ conversas: ConversaResumo[]; temMais: boolean }>(r),
    );
  },
  conversa: (id: string) =>
    fetch(`/api/console/conversa/${id}`).then((r) => json<ConversaDetalhe>(r)),
  conversaMensagens: (id: string, antesDe: string) =>
    fetch(`/api/console/conversa/${id}?antesDe=${encodeURIComponent(antesDe)}`).then((r) =>
      json<PaginaMensagens>(r),
    ),
  marcarLida: (id: string) =>
    fetch(`/api/console/conversa/${id}/lida`, { method: 'POST' }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  ticket: (id: string) => fetch(`/api/console/ticket/${id}`).then((r) => json<TicketDetalhe>(r)),
  acao: (id: string, acao: 'assumir' | 'devolver' | 'resolver') =>
    fetch(`/api/console/ticket/${id}/${acao}`, { method: 'POST' }).then((r) =>
      json<{ status: string }>(r),
    ),
  responder: (id: string, texto: string) =>
    fetch(`/api/console/ticket/${id}/responder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texto, chave: crypto.randomUUID() }),
    }).then((r) => json<{ duplicada: boolean }>(r)),
  traces: (id: string) =>
    fetch(`/api/console/ticket/${id}/traces`).then((r) => json<{ traces: TraceTurnoView[] }>(r)),
  modelos: () =>
    fetch('/api/console/modelos').then((r) =>
      json<{ modelos: Modelo[]; metaConfigurada: boolean }>(r),
    ),
  criarModelo: (def: {
    nome: string;
    idioma?: string;
    categoria?: string;
    corpo: string;
    rodape?: string;
  }) =>
    fetch('/api/console/modelos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(def),
    }).then((r) => json<{ modelo: Modelo }>(r)),
  sincronizarModelos: () =>
    fetch('/api/console/modelos/sincronizar', { method: 'POST' }).then((r) =>
      json<{ modelos: Modelo[]; atualizados: number }>(r),
    ),
  carteira: () =>
    fetch('/api/console/carteira').then((r) => json<{ contatos: ContatoCarteira[] }>(r)),
  disparos: () =>
    fetch('/api/console/disparos').then((r) => json<{ disparos: DisparoResumo[] }>(r)),
  criarDisparo: (corpo: { modeloId: string; variaveis: string[]; waIds: string[] }) =>
    fetch('/api/console/disparos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    }).then((r) => json<{ disparoId: string; destinatarios: number }>(r)),
  disparo: (id: string) =>
    fetch(`/api/console/disparos/${id}`).then((r) =>
      json<{ destinatarios: DisparoDestinatarioView[]; modelo: Modelo }>(r),
    ),
  metricas: (dias: 7 | 30) =>
    fetch(`/api/console/metricas?dias=${dias}`).then((r) => json<Metricas>(r)),
  cobrancas: (status?: StatusCobranca) =>
    fetch(`/api/console/cobrancas${status ? `?status=${status}` : ''}`).then((r) =>
      json<CobrancasResposta>(r),
    ),
  aprovarCobranca: (id: string) =>
    fetch(`/api/console/cobrancas/${id}/aprovar`, { method: 'POST' }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  recusarCobranca: (id: string, motivo: string) =>
    fetch(`/api/console/cobrancas/${id}/recusar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ motivo }),
    }).then((r) => json<{ ok: boolean }>(r)),
  simularPagamento: (id: string) =>
    fetch(`/api/console/cobrancas/${id}/simular-pagamento`, { method: 'POST' }).then((r) =>
      json<{ ok: boolean; psp: string }>(r),
    ),
};

export const STATUS_COBRANCA_LABEL: Record<StatusCobranca, string> = {
  aguardando_aprovacao: 'Aguardando aprovação',
  emitindo: 'Gerando',
  emitida: 'Aguardando pagamento',
  paga: 'Paga',
  expirada: 'Expirada',
  cancelada: 'Cancelada',
  recusada: 'Recusada',
  falha: 'Falha',
  estornada: 'Estornada',
};

export const STATUS_LABEL: Record<TicketResumo['status'], string> = {
  bot_ativo: 'Bot ativo',
  aguardando_humano: 'Aguardando humano',
  humano_ativo: 'Em atendimento',
  resolvido: 'Resolvido',
};
