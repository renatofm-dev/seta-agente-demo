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

/** Instalação (client.yaml + env, só leitura): cabeçalho, nav por módulo e Configurações. */
export interface Instalacao {
  nome: string;
  modulos: {
    financeiro: boolean;
    contrato: boolean;
    atendimento: boolean;
    pagamentos: boolean;
    sdr: boolean;
    /** 038: reserva de utilização de contrato pelo agente. */
    reserva: boolean;
  };
  limites: {
    maxToolCallsPorTurno: number;
    maxMensagensContexto: number;
    maxCaracteresResposta: number;
  };
  guardrails: { temasSensiveis: string[] };
  alcadas: {
    tetoAprovacaoCentavos: number;
    maxCobrancasDia: number;
    diasVencimento: number;
    descontoMaxBps: number;
    maxPropostasDia: number;
    /** 038: acima disto a taxa de manutenção da reserva espera aprovação. */
    tetoTaxaReservaCentavos: number;
  };
  canal: { gateway: 'meta' | 'log-only'; metaConfigurada: boolean; simulador: boolean };
  psp: { nome: string; ambiente: string } | null;
  /** 017: meta global de conversão das campanhas (pagas ÷ entregues), em bps. */
  campanhas: { metaConversaoBps: number };
}

// --- Reservas (038) ---

export type StatusReserva =
  | 'aguardando_aprovacao'
  | 'criando'
  | 'criada'
  | 'confirmada'
  | 'falha'
  | 'cancelada'
  | 'recusada';

export interface HospedeReservaView {
  nome: string;
  sobrenome: string | null;
  cpf: string | null;
  principal: boolean;
}

export interface ReservaView {
  id: string;
  conversaId: string;
  contratoId: string;
  status: StatusReserva;
  checkIn: string;
  checkOut: string;
  idHotel: number;
  hotel: string | null;
  idTipoUh: number;
  tipoUh: string | null;
  adultos: number;
  criancas: number;
  hospedes: HospedeReservaView[];
  custoPontos: number;
  taxaCentavos: number;
  /** `IdUtilizacaoContrato` no TSE — existe a partir de `criada`. */
  erpUtilizacaoId: string | null;
  motivo: string | null;
  aprovadoPor: string | null;
  aprovadoEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface ReservasResposta {
  reservas: ReservaView[];
  contagens: Partial<Record<StatusReserva, number>>;
}

export interface EscritaErp {
  chave: string;
  estado: 'pendente' | 'confirmada' | 'falha';
  erpId: string | null;
  tentativas: number;
  erro: string | null;
  atualizadoEm: string;
}

export interface ReservaDetalhe {
  reserva: ReservaView;
  escrita: EscritaErp | null;
}

// --- Vendas (045) ---

export type StatusVenda =
  | 'sinal_emitido'
  | 'sinal_pago'
  | 'registrando'
  | 'registrada'
  | 'falha'
  | 'cancelada';

export interface VendaView {
  id: string;
  conversaId: string;
  status: StatusVenda;
  /** O CPF chega MASCARADO do server — o console nunca vê o documento inteiro. */
  comprador: { nome: string; cpf: string };
  cotaCodigo: string;
  valorCentavos: number;
  sinalCentavos: number;
  erpContratoId: string | null;
  motivo: string | null;
  criadoEm: string;
}

export interface VendasResposta {
  vendas: VendaView[];
}

export interface VendaDetalhe extends VendaView {
  erpPessoaId: string | null;
  erpCasalId: string | null;
  escrita: { estado: string; tentativas: number; erro: string | null } | null;
  cobranca: {
    status: string;
    metodo: string;
    valorCentavos: number;
    urlFatura: string | null;
    pagoEm: string | null;
  } | null;
  proposta: {
    valorTabelaCentavos: number;
    valorOfertadoCentavos: number;
    status: string;
  } | null;
}

/** Badges da barra superior. */
export interface Resumo {
  aguardandoHumano: number;
  cobrancasAguardandoAprovacao: number;
  leadsAguardandoAprovacao: number;
  /** 038: aguardando aprovação OU criadas e não confirmadas. */
  reservasAguardandoAprovacao: number;
}

export interface PessoaEquipe {
  id: string;
  nome: string;
  email: string;
  role: Sessao['role'];
  criadoEm: string;
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
export type FiltroConversas = 'todas' | 'aguardando' | 'minhas' | 'agente' | 'resolvidas';

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

export type ContagensConversas = Record<FiltroConversas, number>;

export interface MensagemThread {
  id: string;
  autor: 'contato' | 'bot' | 'atendente' | 'campanha';
  atendenteId: string | null;
  atendenteNome: string | null;
  texto: string;
  status: 'recebida' | 'pendente' | 'enviada' | 'entregue' | 'lida' | 'falha';
  criadoEm: string;
}

/** Resumo da inadimplência do contrato (financeiro.titulos_atraso); null sem vínculo/ERP. */
export interface FinanceiroContrato {
  vencidas: number;
  saldoVencidoCentavos: number;
  maiorAtrasoDias: number;
  vencimentoMaisAntigo: string | null;
}

/** Campanha (disparo) mais recente que alcançou o número da conversa. */
export interface OrigemCampanha {
  disparoId: string;
  modelo: string;
  enviadoEm: string;
  statusDestinatario: 'pendente' | 'enviado' | 'entregue' | 'lido' | 'falha';
}

export interface ConversaDetalhe {
  conversaId: string;
  waId: string;
  contatoNome: string | null;
  clienteErpId: string | null;
  janelaExpiraEm: string | null;
  limiteResposta: number;
  financeiro: FinanceiroContrato | null;
  origem: OrigemCampanha | null;
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

// --- Disparos de template (013) → Campanhas --------------------------------

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
  /** 017: rótulo da campanha; null ⇒ usar `modelo_nome`. */
  nome: string | null;
  /** 017: meta própria em bps; null ⇒ global da instalação. */
  meta_conversao_bps: number | null;
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
  atualizadoEm: string;
}

export interface DisparoDetalhe {
  disparo: {
    id: string;
    modeloId: string;
    variaveis: string[];
    nome: string | null;
    metaConversaoBps: number | null;
    status: 'enviando' | 'concluido';
    criadoPor: string;
    criadoEm: string;
    atualizadoEm: string;
  };
  modelo: Modelo;
  destinatarios: DisparoDestinatarioView[];
}

// --- Relatórios (017) → Métricas › Campanhas --------------------------------

export type JanelaAtribuicao = 7 | 15 | 30 | 60;
export const JANELAS_ATRIBUICAO: readonly JanelaAtribuicao[] = [7, 15, 30, 60];

export interface ContagensCampanha {
  destinatarios: number;
  enviadas: number;
  entregues: number;
  lidas: number;
  falhas: number;
  responderam: number;
  cobrancas: number;
  pagas: number;
  valorRecuperadoCentavos: number;
  escaladas: number;
  /** Mediana de horas entre o envio e o primeiro pagamento; null sem pagamento. */
  medianaHorasPagamento: number | null;
  /** pagas ÷ entregues em bps; null sem entrega. */
  conversaoBps: number | null;
}

export interface LinhaRelatorioCampanha extends ContagensCampanha {
  id: string;
  nome: string;
  modelo: string;
  status: 'enviando' | 'concluido';
  criadoEm: string;
  /** YYYY-MM (mês de envio no fuso do cliente). */
  competencia: string;
  metaBps: number;
}

export interface TotaisRelatorio extends ContagensCampanha {
  campanhas: number;
  /** Meta ponderada pelas entregas; sem entrega, a global. */
  metaBps: number;
}

export interface FiltrosRelatorio {
  de?: string;
  ate?: string;
  competencia?: string;
  modelo?: string;
  janelaDias?: JanelaAtribuicao;
}

export interface RelatorioCampanhas {
  filtros: {
    de: string;
    ate: string;
    competencia: string | null;
    modelo: string | null;
    janelaDias: JanelaAtribuicao;
    metaGlobalBps: number;
  };
  campanhas: LinhaRelatorioCampanha[];
  totais: TotaisRelatorio;
  anterior: { de: string; ate: string; totais: TotaisRelatorio };
  opcoes: { competencias: string[]; modelos: string[] };
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

export interface FeedbackTurno {
  avaliacao: 'bom' | 'ruim';
  motivos: string[];
  sugestao: string | null;
}

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
  feedback: FeedbackTurno | null;
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

// --- Cobranças (014) --------------------------------------------------------

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

export type MetodoCobranca = 'boleto' | 'pix' | 'cartao';

export interface CobrancaView {
  id: string;
  conversaId: string;
  contratoId: string;
  status: StatusCobranca;
  metodo: MetodoCobranca;
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
  /** Server já combina DEV_SIMULATOR com o ambiente do PSP (042) — não recombinar aqui. */
  simuladorAtivo: boolean;
  contagens: Partial<Record<StatusCobranca, number>>;
  eventosPspPendentes: number;
  cobrancas: CobrancaView[];
}

/** Evento do PSP como o console o vê (042). `id` é text e contém `&`. */
export interface EventoPspView {
  id: string;
  psp: string;
  tipo: string;
  pspCobrancaId: string | null;
  recebidoEm: string;
  processadoEm: string | null;
  erro: string | null;
  cobrancaId: string | null;
}

export interface CobrancaDetalhe {
  cobranca: {
    id: string;
    conversaId: string;
    contratoId: string;
    referenciaExterna: string;
    status: StatusCobranca;
    metodo: MetodoCobranca;
    valorCentavos: number;
    vencimentoPsp: string;
    psp: string;
    pspCobrancaId: string | null;
    urlFatura: string | null;
    urlBoleto: string | null;
    linhaDigitavel: string | null;
    pixCopiaCola: string | null;
    motivo: string | null;
    aprovadoPor: string | null;
    aprovadoEm: string | null;
    pagoEm: string | null;
    tentativas: number;
    criadoEm: string;
    atualizadoEm: string;
  };
  titulos: {
    tituloId: string;
    origem: 'entrada' | 'saldo';
    parcela: number;
    totalParcelas: number | null;
    valorCentavos: number;
    vencimento: string;
  }[];
  eventos: {
    id: string;
    tipo: string;
    recebidoEm: string;
    processadoEm: string | null;
    erro: string | null;
  }[];
}

// --- Leads (015, leitura) ---------------------------------------------------

export type StatusLead =
  | 'novo'
  | 'qualificando'
  | 'qualificado'
  | 'proposta'
  | 'agendado'
  | 'perdido';
export type StatusPropostaSdr =
  | 'rascunho'
  | 'ofertada'
  | 'aguardando_aprovacao'
  | 'aceita'
  | 'recusada'
  | 'expirada';

export interface PerfilLead {
  pessoas: number | null;
  periodos: number | null;
  contato: string | null;
}

export interface PropostaSdrView {
  id: string;
  status: StatusPropostaSdr;
  cotaCodigo: string;
  valorTabelaCentavos: number;
  valorMinimoCentavos: number;
  valorOfertadoCentavos: number;
  descontoBps: number;
  valorPedidoCentavos: number | null;
  motivo: string | null;
  criadoEm: string | null;
}

export interface LeadView {
  id: string;
  waId: string;
  nome: string | null;
  status: StatusLead;
  perfil: PerfilLead;
  conversaId: string | null;
  criadoEm: string;
  atualizadoEm: string;
  proposta: PropostaSdrView | null;
}

export interface LeadDetalhe {
  lead: Omit<LeadView, 'proposta'> & { origem: string };
  propostas: (PropostaSdrView & { aprovadoPor: string | null; atualizadoEm: string })[];
  fluxo: {
    etapa: 'qualificacao' | 'apresentacao' | 'oferta' | 'agendamento' | 'encerrado';
    oferta: 'tabela' | 'piso' | null;
    encerramento: string | null;
    atualizadoEm: string;
  } | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const corpo = await res.text();
    let msg = corpo;
    try {
      const j = JSON.parse(corpo) as { erro?: string; detalhe?: string };
      msg = j.erro ? `${j.erro}${j.detalhe ? ` — ${j.detalhe}` : ''}` : corpo;
    } catch {
      // corpo não é JSON: mantém o texto
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

// O content-type só vai junto com o corpo: `application/json` sem corpo é
// recusado pelo Fastify (FST_ERR_CTP_EMPTY_JSON_BODY) e derrubava as ações
// sem payload — aprovar, simular pagamento, reprocessar evento (042).
const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });

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
  /** Público (tela de login): só o nome da instalação. */
  instalacaoPublica: async (): Promise<{ nome: string } | null> => {
    const res = await fetch('/api/instalacao').catch(() => null);
    return res?.ok ? (res.json() as Promise<{ nome: string }>) : null;
  },
  instalacao: () => fetch('/api/console/instalacao').then((r) => json<Instalacao>(r)),
  resumo: () => fetch('/api/console/resumo').then((r) => json<Resumo>(r)),
  equipe: () => fetch('/api/console/equipe').then((r) => json<{ pessoas: PessoaEquipe[] }>(r)),
  inbox: () => fetch('/api/console/inbox').then((r) => json<Inbox>(r)),
  conversas: (filtro: FiltroConversas, q: string) => {
    const params = new URLSearchParams({ filtro });
    if (q.trim()) params.set('q', q.trim());
    return fetch(`/api/console/conversas?${params}`).then((r) =>
      json<{ conversas: ConversaResumo[]; temMais: boolean; contagens: ContagensConversas }>(r),
    );
  },
  conversa: (id: string) =>
    fetch(`/api/console/conversa/${id}`).then((r) => json<ConversaDetalhe>(r)),
  conversaMensagens: (id: string, antesDe: string) =>
    fetch(`/api/console/conversa/${id}?antesDe=${encodeURIComponent(antesDe)}`).then((r) =>
      json<PaginaMensagens>(r),
    ),
  marcarLida: (id: string) =>
    post(`/api/console/conversa/${id}/lida`).then((r) => json<{ ok: boolean }>(r)),
  ticket: (id: string) => fetch(`/api/console/ticket/${id}`).then((r) => json<TicketDetalhe>(r)),
  acao: (id: string, acao: 'assumir' | 'devolver' | 'resolver') =>
    post(`/api/console/ticket/${id}/${acao}`).then((r) => json<{ status: string }>(r)),
  responder: (id: string, texto: string) =>
    post(`/api/console/ticket/${id}/responder`, { texto, chave: crypto.randomUUID() }).then((r) =>
      json<{ duplicada: boolean }>(r),
    ),
  traces: (id: string) =>
    fetch(`/api/console/ticket/${id}/traces`).then((r) => json<{ traces: TraceTurnoView[] }>(r)),
  feedbackTurno: (
    traceTurnoId: string,
    corpo: { avaliacao: 'bom' | 'ruim'; motivos?: string[]; sugestao?: string },
  ) =>
    post(`/api/console/traces/${traceTurnoId}/feedback`, corpo).then((r) =>
      json<{ ok: boolean; feedback: FeedbackTurno }>(r),
    ),
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
  }) => post('/api/console/modelos', def).then((r) => json<{ modelo: Modelo }>(r)),
  sincronizarModelos: () =>
    post('/api/console/modelos/sincronizar').then((r) =>
      json<{ modelos: Modelo[]; atualizados: number }>(r),
    ),
  carteira: () =>
    fetch('/api/console/carteira').then((r) => json<{ contatos: ContatoCarteira[] }>(r)),
  disparos: () =>
    fetch('/api/console/disparos').then((r) => json<{ disparos: DisparoResumo[] }>(r)),
  criarDisparo: (corpo: {
    modeloId: string;
    variaveis: string[];
    waIds: string[];
    nome?: string;
    metaConversaoBps?: number;
  }) =>
    post('/api/console/disparos', corpo).then((r) =>
      json<{ disparoId: string; destinatarios: number }>(r),
    ),
  relatorioCampanhas: (f: FiltrosRelatorio) => {
    const params = new URLSearchParams();
    if (f.de) params.set('de', f.de);
    if (f.ate) params.set('ate', f.ate);
    if (f.competencia) params.set('competencia', f.competencia);
    if (f.modelo) params.set('modelo', f.modelo);
    if (f.janelaDias) params.set('janelaDias', String(f.janelaDias));
    const qs = params.toString();
    return fetch(`/api/console/relatorios/campanhas${qs ? `?${qs}` : ''}`).then((r) =>
      json<RelatorioCampanhas>(r),
    );
  },
  disparo: (id: string) =>
    fetch(`/api/console/disparos/${id}`).then((r) => json<DisparoDetalhe>(r)),
  metricas: (dias: 7 | 30) =>
    fetch(`/api/console/metricas?dias=${dias}`).then((r) => json<Metricas>(r)),
  cobrancas: (filtro?: { status?: StatusCobranca; conversaId?: string }) => {
    const params = new URLSearchParams();
    if (filtro?.status) params.set('status', filtro.status);
    if (filtro?.conversaId) params.set('conversaId', filtro.conversaId);
    const qs = params.toString();
    return fetch(`/api/console/cobrancas${qs ? `?${qs}` : ''}`).then((r) =>
      json<CobrancasResposta>(r),
    );
  },
  cobranca: (id: string) =>
    fetch(`/api/console/cobrancas/${id}`).then((r) => json<CobrancaDetalhe>(r)),
  aprovarCobranca: (id: string) =>
    post(`/api/console/cobrancas/${id}/aprovar`).then((r) => json<{ ok: boolean }>(r)),
  // --- Reservas (038) ---
  reservas: (filtro?: { status?: StatusReserva; conversaId?: string }) => {
    const params = new URLSearchParams();
    if (filtro?.status) params.set('status', filtro.status);
    if (filtro?.conversaId) params.set('conversaId', filtro.conversaId);
    const qs = params.toString();
    return fetch(`/api/console/reservas${qs ? `?${qs}` : ''}`).then((r) =>
      json<ReservasResposta>(r),
    );
  },
  reserva: (id: string) =>
    fetch(`/api/console/reservas/${id}`).then((r) => json<ReservaDetalhe>(r)),

  // --- Vendas (045) ---
  vendas: (filtro?: { status?: StatusVenda; conversaId?: string }) => {
    const params = new URLSearchParams();
    if (filtro?.status) params.set('status', filtro.status);
    if (filtro?.conversaId) params.set('conversaId', filtro.conversaId);
    const qs = params.toString();
    return fetch(`/api/console/vendas${qs ? `?${qs}` : ''}`).then((r) => json<VendasResposta>(r));
  },
  venda: (id: string) => fetch(`/api/console/vendas/${id}`).then((r) => json<VendaDetalhe>(r)),
  aprovarReserva: (id: string) =>
    post(`/api/console/reservas/${id}/aprovar`).then((r) => json<{ ok: boolean }>(r)),
  recusarReserva: (id: string, motivo: string) =>
    post(`/api/console/reservas/${id}/recusar`, { motivo }).then((r) => json<{ ok: boolean }>(r)),

  recusarCobranca: (id: string, motivo: string) =>
    post(`/api/console/cobrancas/${id}/recusar`, { motivo }).then((r) => json<{ ok: boolean }>(r)),
  simularPagamento: (id: string) =>
    post(`/api/console/cobrancas/${id}/simular-pagamento`).then((r) =>
      json<{ ok: boolean; psp: string }>(r),
    ),
  eventosPsp: (pendente = true) =>
    fetch(`/api/console/eventos-psp${pendente ? '?pendente=true' : ''}`).then((r) =>
      json<{ eventos: EventoPspView[]; pendentes: number }>(r),
    ),
  // encodeURIComponent é obrigatório: o id do Asaas é `evt_<hash>&<sequência>`.
  reprocessarEventoPsp: (id: string) =>
    post(`/api/console/eventos-psp/${encodeURIComponent(id)}/reprocessar`).then((r) =>
      json<{ ok: boolean; reenfileirado: boolean; motivo?: string }>(r),
    ),
  leads: () => fetch('/api/console/leads').then((r) => json<{ leads: LeadView[] }>(r)),
  lead: (id: string) => fetch(`/api/console/leads/${id}`).then((r) => json<LeadDetalhe>(r)),
};
