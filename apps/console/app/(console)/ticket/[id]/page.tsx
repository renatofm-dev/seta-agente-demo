'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/console-api';

/**
 * #45: o ticket deixou de ser página — a tela é o /inbox em duas colunas.
 * Esta rota sobrevive só para links antigos: resolve a conversa e redireciona.
 */
export default function TicketRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    api
      .ticket(id)
      .then((t) => router.replace(`/inbox?c=${t.conversaId}`))
      .catch(() => router.replace('/inbox'));
  }, [id, router]);

  return <main className="flex h-full items-center justify-center text-sm">Redirecionando…</main>;
}
