import type { Papel } from '@/components/ui/chip';
import type {
  MensagemThread,
  StatusCobranca,
  StatusLead,
  StatusPropostaSdr,
  StatusReserva,
  StatusTicket,
  StatusVenda,
  TraceEvento,
} from './console-api';

/**
 * Vocabulário de estados do design (seção 7): rótulo curto em pt-BR + papel
 * semântico. Códigos técnicos só aparecem em tooltip/trace/configurações.
 */

export const STATUS_TICKET: Record<StatusTicket, { rotulo: string; papel: Papel }> = {
  bot_ativo: { rotulo: 'Agente', papel: 'info' },
  aguardando_humano: { rotulo: 'Aguardando', papel: 'warn' },
  humano_ativo: { rotulo: 'Em atendimento', papel: 'ok' },
  resolvido: { rotulo: 'Resolvida', papel: 'off' },
};

export const STATUS_COBRANCA: Record<StatusCobranca, { rotulo: string; papel: Papel }> = {
  aguardando_aprovacao: { rotulo: 'Aguardando aprovação', papel: 'warn' },
  emitindo: { rotulo: 'Gerando', papel: 'info' },
  emitida: { rotulo: 'Aguardando pagamento', papel: 'info' },
  paga: { rotulo: 'Paga', papel: 'ok' },
  expirada: { rotulo: 'Expirada', papel: 'off' },
  cancelada: { rotulo: 'Cancelada', papel: 'off' },
  recusada: { rotulo: 'Recusada', papel: 'risk' },
  falha: { rotulo: 'Falha', papel: 'risk' },
  estornada: { rotulo: 'Estornada', papel: 'risk' },
};

export const METODO_COBRANCA = { boleto: 'Boleto', pix: 'PIX', cartao: 'Cartão' } as const;

/**
 * 038. `criada` é o estado que pede atenção: a utilização EXISTE no TSE
 * segurando pontos do cotista, mas ainda não foi confirmada.
 */
export const STATUS_RESERVA: Record<StatusReserva, { rotulo: string; papel: Papel }> = {
  aguardando_aprovacao: { rotulo: 'Aguardando aprovação', papel: 'warn' },
  criando: { rotulo: 'Registrando', papel: 'info' },
  criada: { rotulo: 'Criada, não confirmada', papel: 'warn' },
  confirmada: { rotulo: 'Confirmada', papel: 'ok' },
  falha: { rotulo: 'Falha', papel: 'risk' },
  cancelada: { rotulo: 'Cancelada', papel: 'off' },
  recusada: { rotulo: 'Recusada', papel: 'risk' },
};

/** 045: os seis estados da venda. `sinal_pago` é warn de propósito — é dinheiro
 * recebido cujo contrato ainda não existe no ERP. */
export const STATUS_VENDA: Record<StatusVenda, { rotulo: string; papel: Papel }> = {
  sinal_emitido: { rotulo: 'Aguardando sinal', papel: 'info' },
  sinal_pago: { rotulo: 'Sinal pago', papel: 'warn' },
  registrando: { rotulo: 'Registrando', papel: 'info' },
  registrada: { rotulo: 'Contrato criado', papel: 'ok' },
  falha: { rotulo: 'Falha', papel: 'risk' },
  cancelada: { rotulo: 'Cancelada', papel: 'off' },
};

export const STATUS_LEAD: Record<StatusLead, { rotulo: string; papel: Papel }> = {
  novo: { rotulo: 'Novo', papel: 'info' },
  qualificando: { rotulo: 'Qualificando', papel: 'info' },
  qualificado: { rotulo: 'Qualificado', papel: 'info' },
  proposta: { rotulo: 'Proposta', papel: 'info' },
  agendado: { rotulo: 'Agendado', papel: 'ok' },
  perdido: { rotulo: 'Perdido', papel: 'off' },
};

export const STATUS_PROPOSTA: Record<StatusPropostaSdr, { rotulo: string; papel: Papel }> = {
  rascunho: { rotulo: 'Rascunho', papel: 'off' },
  ofertada: { rotulo: 'Ofertada', papel: 'info' },
  aguardando_aprovacao: { rotulo: 'Aguardando aprovação', papel: 'warn' },
  aceita: { rotulo: 'Aceita', papel: 'ok' },
  recusada: { rotulo: 'Recusada', papel: 'risk' },
  expirada: { rotulo: 'Expirada', papel: 'off' },
};

/** Estado "visível" do lead: a proposta que espera gente sobrepõe o status do lead. */
export function estadoLead(
  status: StatusLead,
  proposta: { status: StatusPropostaSdr } | null,
): { rotulo: string; papel: Papel; codigo: string } {
  if (proposta?.status === 'aguardando_aprovacao') {
    return { ...STATUS_PROPOSTA.aguardando_aprovacao, codigo: 'aguardando_aprovacao' };
  }
  return { ...STATUS_LEAD[status], codigo: status };
}

export const STATUS_DISPARO: Record<'enviando' | 'concluido', { rotulo: string; papel: Papel }> = {
  enviando: { rotulo: 'Enviando', papel: 'info' },
  concluido: { rotulo: 'Concluída', papel: 'ok' },
};

export const STATUS_DESTINATARIO: Record<
  'pendente' | 'enviado' | 'entregue' | 'lido' | 'falha',
  { rotulo: string; papel: Papel }
> = {
  pendente: { rotulo: 'Pendente', papel: 'off' },
  enviado: { rotulo: 'Enviado', papel: 'info' },
  entregue: { rotulo: 'Entregue', papel: 'info' },
  lido: { rotulo: 'Lido', papel: 'ok' },
  falha: { rotulo: 'Falha', papel: 'risk' },
};

export const STATUS_MODELO: Record<
  'pendente' | 'aprovado' | 'rejeitado' | 'desconhecido',
  { rotulo: string; papel: Papel }
> = {
  aprovado: { rotulo: 'Aprovado Meta', papel: 'ok' },
  pendente: { rotulo: 'Em análise', papel: 'warn' },
  rejeitado: { rotulo: 'Rejeitado', papel: 'risk' },
  desconhecido: { rotulo: 'Desconhecido', papel: 'off' },
};

/** Motivos de escalonamento (guardrails 006, cobrança 014, SDR 015). */
const MOTIVO_ESCALONAMENTO: Record<string, string> = {
  negociacao_preco: 'Pedido de desconto / negociação',
  tema_sensivel: 'Tema sensível (jurídico, imprensa, consumidor)',
  pedido_explicito: 'Pediu para falar com humano',
  interesse_compra: 'Interesse em comprar cota',
  aprovacao_cobranca: 'Cobrança acima do teto',
  cobranca_bloqueada: 'Cobrança bloqueada',
  falha_emissao_cobranca: 'Falha na emissão da cobrança',
  desconto_acima_alcada: 'Desconto acima da alçada (vendas)',
  falha_entrega: 'Falha na entrega da mensagem',
  janela_fechada: 'Janela de 24h fechada',
};

export function motivoLabel(codigo: string | null | undefined): string {
  if (!codigo) return 'Sem motivo registrado';
  const conhecido = MOTIVO_ESCALONAMENTO[codigo];
  if (conhecido) return conhecido;
  const texto = codigo.replaceAll('_', ' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Gatilhos de escalada obrigatória mostrados em Configurações › Regras. */
export const GATILHOS_ESCALADA = [
  {
    codigo: 'negociacao_preco',
    rotulo: 'Pedido de desconto ou negociação',
    desc: 'Qualquer menção a desconto, parcelamento fora da regra ou abatimento.',
  },
  {
    codigo: 'tema_sensivel',
    rotulo: 'Tema sensível',
    desc: 'Temas da lista configurada (jurídico, imprensa, órgão de defesa do consumidor…).',
  },
  {
    codigo: 'pedido_explicito',
    rotulo: 'Pediu para falar com humano',
    desc: 'Palavras como "atendente", "pessoa", "humano".',
  },
  {
    codigo: 'interesse_compra',
    rotulo: 'Interesse em comprar cota',
    desc: 'Cotista quer outra cota ou upgrade; sem vínculo, o SDR qualifica e passa ao comercial.',
  },
  {
    codigo: 'aprovacao_cobranca',
    rotulo: 'Cobrança acima do teto',
    desc: 'Valor total acima do teto de emissão automática espera aprovação.',
  },
  {
    codigo: 'desconto_acima_alcada',
    rotulo: 'Desconto acima da alçada (vendas)',
    desc: 'Lead pede valor abaixo do piso do agente; o comercial decide.',
  },
] as const;

/** Motivos do 👎 no feedback do atendente (espelho do servidor). */
export const MOTIVOS_FEEDBACK = [
  { codigo: 'tom_inadequado', rotulo: 'Tom inadequado' },
  { codigo: 'informacao_errada', rotulo: 'Informação errada' },
  { codigo: 'devia_ter_escalado', rotulo: 'Devia ter escalado' },
  { codigo: 'nao_devia_ter_escalado', rotulo: 'Não devia ter escalado' },
  { codigo: 'resposta_longa', rotulo: 'Resposta longa' },
] as const;
export type MotivoFeedback = (typeof MOTIVOS_FEEDBACK)[number]['codigo'];

/** Papel semântico de cada evento do trace (linha de eventos do Aprendizado). */
export const PAPEL_EVENTO: Record<TraceEvento['tipo'], Papel> = {
  contexto: 'off',
  llm: 'info',
  tool: 'ok',
  verdict: 'warn',
  fallback: 'risk',
  escalado: 'risk',
  descartado: 'off',
};

/** Etiqueta acima do balão + cores por autor (5 variantes do design). */
export const BALAO: Record<
  MensagemThread['autor'],
  { etiqueta: string; classe: string; etiquetaCor: string }
> = {
  contato: { etiqueta: '', classe: 'bg-surface border-line', etiquetaCor: '' },
  bot: { etiqueta: 'Agente', classe: 'bg-balao-agente border-ok/18', etiquetaCor: 'text-ok' },
  atendente: {
    etiqueta: 'Atendente',
    classe: 'bg-balao-atendente border-brand/20',
    etiquetaCor: 'text-brand',
  },
  campanha: {
    etiqueta: 'Campanha',
    classe: 'bg-balao-campanha border-warn-2/35',
    etiquetaCor: 'text-warn',
  },
};
