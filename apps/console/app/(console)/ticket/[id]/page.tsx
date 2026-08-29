'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, STATUS_LABEL, type TicketDetalhe } from '@/lib/console-api';
import { cn } from '@/lib/utils';
import { useSessao } from '../../layout';
import { TraceViewer } from './trace-viewer';

/** Ticket ao vivo: conversa, ações HITL e painel lateral com dados do ERP. */

const CORES_AUTOR: Record<string, string> = {
  contato: 'bg-primary text-primary-foreground',
  bot: 'bg-muted',
  atendente: 'bg-emerald-600/90 text-white',
};

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sessao = useSessao();
  const [ticket, setTicket] = useState<TicketDetalhe | null>(null);
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aba, setAba] = useState<'conversa' | 'trace'>('conversa');
  const fimRef = useRef<HTMLDivElement>(null);

  const conversaIdRef = useRef<string | null>(null);
  const recarregar = useCallback(() => {
    api
      .ticket(id)
      .then((t) => {
        conversaIdRef.current = t.conversaId;
        setTicket(t);
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    recarregar();
    const es = new EventSource('/api/console/events');
    // #31: só eventos DESTA conversa recarregam (o refetch do detalhe consulta
    // o perfil no ERP — evento global de outra conversa não pode custar isso)
    const aoEvento = (ev: MessageEvent) => {
      try {
        const dado = JSON.parse(String(ev.data)) as { conversaId?: string };
        if (!conversaIdRef.current || dado.conversaId === conversaIdRef.current) recarregar();
      } catch {
        recarregar();
      }
    };
    es.addEventListener('ticket', aoEvento);
    es.addEventListener('mensagem', aoEvento);
    // polling é SÓ fallback de SSE caído
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    es.onopen = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    es.onerror = () => {
      if (!pollTimer) pollTimer = setInterval(recarregar, 3_000);
    };
    return () => {
      es.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [recarregar]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rolar ao fim a cada mensagem nova
  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ticket?.mensagens.length]);

  if (!ticket) {
    return <main className="flex h-full items-center justify-center text-sm">Carregando…</main>;
  }

  const minhaPosse = ticket.status === 'humano_ativo' && ticket.atendenteId === sessao?.userId;

  async function acao(nome: 'assumir' | 'devolver' | 'resolver') {
    setErro(null);
    try {
      await api.acao(ticket?.id ?? '', nome);
      recarregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    }
  }

  async function responder(e: React.FormEvent) {
    e.preventDefault();
    const corpo = texto.trim();
    if (!corpo) return;
    setTexto('');
    setErro(null);
    try {
      await api.responder(ticket?.id ?? '', corpo);
      recarregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    }
  }

  const perfil = ticket.perfilErp as {
    razao_social?: string;
    nome_fantasia?: string;
    documento?: string;
  } | null;

  return (
    <main className="grid h-full grid-cols-1 gap-0 lg:grid-cols-[1fr_280px]">
      <section className="flex h-full flex-col overflow-hidden">
        <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
          <button
            type="button"
            onClick={() => router.push('/inbox')}
            className="text-muted-foreground"
          >
            ← Inbox
          </button>
          <span className="font-medium">{ticket.contatoNome ?? ticket.waId}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {STATUS_LABEL[ticket.status]}
          </span>
          <div className="flex rounded-md border text-xs">
            {(['conversa', 'trace'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setAba(t)}
                className={cn('px-2 py-1 capitalize', aba === t && 'bg-muted font-medium')}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {ticket.status === 'aguardando_humano' && (
              <button
                type="button"
                onClick={() => acao('assumir')}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Assumir
              </button>
            )}
            {minhaPosse && (
              <>
                <button
                  type="button"
                  onClick={() => acao('devolver')}
                  className="rounded-md border px-3 py-1 text-xs"
                >
                  Devolver ao bot
                </button>
                <button
                  type="button"
                  onClick={() => acao('resolver')}
                  className="rounded-md border px-3 py-1 text-xs"
                >
                  Resolver
                </button>
              </>
            )}
          </div>
        </header>

        {aba === 'trace' && (
          <div className="flex-1 overflow-y-auto">
            <TraceViewer ticketId={ticket.id} />
          </div>
        )}

        <div className={cn('flex-1 space-y-2 overflow-y-auto p-4', aba !== 'conversa' && 'hidden')}>
          {ticket.mensagens.map((m) => (
            <div
              key={m.id}
              className={cn('flex', m.autor === 'contato' ? 'justify-start' : 'justify-end')}
            >
              <div className={cn('max-w-[75%] rounded-lg px-3 py-2 text-sm', CORES_AUTOR[m.autor])}>
                <p className="whitespace-pre-wrap">{m.texto}</p>
                <p className="mt-1 text-[10px] opacity-70">
                  {m.autor} · {new Date(m.criadoEm).toLocaleTimeString('pt-BR')}
                </p>
              </div>
            </div>
          ))}
          <div ref={fimRef} />
        </div>

        <form onSubmit={responder} className="flex gap-2 border-t p-3">
          <input
            className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm disabled:opacity-50"
            placeholder={
              minhaPosse ? 'Responder como atendente…' : 'Assuma o ticket para responder'
            }
            disabled={!minhaPosse}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          <button
            type="submit"
            disabled={!minhaPosse || !texto.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
        {erro && <p className="border-t px-3 py-2 text-xs text-red-600">{erro}</p>}
      </section>

      <aside className="hidden border-l p-4 text-sm lg:block">
        <h3 className="font-semibold">Cliente (ERP)</h3>
        {perfil ? (
          <dl className="mt-2 space-y-1 text-xs">
            <div>
              <dt className="text-muted-foreground">Razão social</dt>
              <dd>{perfil.razao_social}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Nome fantasia</dt>
              <dd>{perfil.nome_fantasia ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">CNPJ</dt>
              <dd>{perfil.documento}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Sem vínculo ou ERP indisponível.</p>
        )}
        <h3 className="mt-6 font-semibold">Escalonamento</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {ticket.motivoEscalonamento ?? 'Sem escalonamento registrado.'}
        </p>
      </aside>
    </main>
  );
}
