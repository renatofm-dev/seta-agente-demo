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
};

export const STATUS_LABEL: Record<TicketResumo['status'], string> = {
  bot_ativo: 'Bot ativo',
  aguardando_humano: 'Aguardando humano',
  humano_ativo: 'Em atendimento',
  resolvido: 'Resolvido',
};
