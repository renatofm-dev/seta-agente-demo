'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Inbox, STATUS_LABEL, type TicketResumo } from '@/lib/console-api';
import { cn } from '@/lib/utils';

/** Inbox em três filas com SSE (fallback: polling a cada 3 s). */

function tempoEspera(s: number | null): string {
  if (s === null) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}min`;
}

function CartaoTicket({ t, destaque }: { t: TicketResumo; destaque?: boolean }) {
  return (
    <Link
      href={`/ticket/${t.id}`}
      className={cn(
        'block rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50',
        destaque && 'border-amber-500/60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t.contatoNome ?? t.waId ?? '—'}</span>
        {t.esperaSegundos !== null && t.status === 'aguardando_humano' && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">
            {tempoEspera(t.esperaSegundos)}
          </span>
        )}
      </div>
      {t.motivoEscalonamento && t.status === 'aguardando_humano' && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">⚠ {t.motivoEscalonamento}</p>
      )}
      {t.ultimaMensagem && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {t.ultimaMensagem.autor}: {t.ultimaMensagem.texto}
        </p>
      )}
    </Link>
  );
}

export default function InboxPage() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [aoVivo, setAoVivo] = useState(false);
  const recarregarRef = useRef<() => void>(() => {});

  const recarregar = useCallback(() => {
    api
      .inbox()
      .then(setInbox)
      .catch(() => {});
  }, []);
  recarregarRef.current = recarregar;

  useEffect(() => {
    recarregar();
    const es = new EventSource('/api/console/events');
    es.onopen = () => setAoVivo(true);
    es.onerror = () => setAoVivo(false);
    const aoEvento = () => recarregarRef.current();
    es.addEventListener('ticket', aoEvento);
    es.addEventListener('mensagem', aoEvento);
    // fallback: polling 3 s cobre SSE caído (e serve de refresh do tempo de espera)
    const timer = setInterval(() => recarregarRef.current(), 3_000);
    return () => {
      es.close();
      clearInterval(timer);
    };
  }, [recarregar]);

  const filas: { chave: keyof Inbox; titulo: string; destaque?: boolean }[] = [
    { chave: 'aguardando', titulo: STATUS_LABEL.aguardando_humano, destaque: true },
    { chave: 'meus', titulo: 'Meus tickets' },
    { chave: 'botAtivo', titulo: STATUS_LABEL.bot_ativo },
  ];

  return (
    <main className="grid h-full grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-3">
      {filas.map((fila) => (
        <section key={fila.chave} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {fila.titulo}
            <span className="rounded-full bg-muted px-2 text-xs">
              {inbox?.[fila.chave].length ?? 0}
            </span>
            {fila.chave === 'aguardando' && (
              <span
                className={cn(
                  'ml-auto h-2 w-2 rounded-full',
                  aoVivo ? 'bg-green-500' : 'bg-red-500',
                )}
                title={aoVivo ? 'ao vivo (SSE)' : 'polling'}
              />
            )}
          </h2>
          <div className="space-y-2">
            {(inbox?.[fila.chave] ?? []).map((t) => (
              <CartaoTicket key={t.id} t={t} destaque={fila.destaque} />
            ))}
            {inbox && inbox[fila.chave].length === 0 && (
              <p className="text-xs text-muted-foreground">Fila vazia.</p>
            )}
          </div>
        </section>
      ))}
    </main>
  );
}
