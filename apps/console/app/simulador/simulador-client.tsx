'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Simulador de WhatsApp (plano B da demo): injeta mensagens no mesmo caminho
 * do webhook e acompanha a conversa via SSE. Requer DEV_SIMULATOR=true no server.
 */

interface MensagemEvento {
  id: string;
  direcao: 'in' | 'out';
  texto: string;
  status: string;
  criadoEm: string;
}

interface TurnoEvento {
  id: string;
  textoAgregado: string;
}

type Evento = { tipo: 'mensagem'; dados: MensagemEvento } | { tipo: 'turno'; dados: TurnoEvento };

const WA_ID_PADRAO = '5511999990001';

export default function SimuladorClient() {
  const [waId, setWaId] = useState(WA_ID_PADRAO);
  const [conectado, setConectado] = useState(false);
  const [texto, setTexto] = useState('');
  const [eventos, setEventos] = useState<Evento[]>([]);
  const fimRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vistos = new Set<string>();
    const es = new EventSource(`/api-dev/dev/events?waId=${encodeURIComponent(waId)}`);
    es.onopen = () => setConectado(true);
    es.onerror = () => setConectado(false);
    es.addEventListener('mensagem', (ev) => {
      const dados = JSON.parse(ev.data) as MensagemEvento;
      if (vistos.has(dados.id)) return;
      vistos.add(dados.id);
      setEventos((prev) => [...prev, { tipo: 'mensagem', dados }]);
    });
    es.addEventListener('turno', (ev) => {
      const dados = JSON.parse(ev.data) as TurnoEvento;
      if (vistos.has(dados.id)) return;
      vistos.add(dados.id);
      setEventos((prev) => [...prev, { tipo: 'turno', dados }]);
    });
    return () => es.close();
  }, [waId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rolar ao fim a cada evento novo é o efeito desejado
  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [eventos]);

  const enviar = useCallback(async () => {
    const corpo = texto.trim();
    if (!corpo) return;
    setTexto('');
    await fetch('/api-dev/dev/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waId, text: corpo }),
    });
  }, [texto, waId]);

  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Simulador WhatsApp</h1>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            conectado ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-600',
          )}
        >
          {conectado ? 'conectado' : 'desconectado'}
        </span>
        <input
          className="ml-auto w-44 rounded-md border bg-transparent px-2 py-1 text-sm"
          value={waId}
          onChange={(e) => setWaId(e.target.value.replace(/\D/g, ''))}
          aria-label="wa_id do contato"
        />
      </header>

      <section className="flex-1 space-y-2 overflow-y-auto rounded-lg border p-3">
        {eventos.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Envie uma mensagem — ela entra pelo mesmo caminho do webhook (idempotência + debounce).
          </p>
        )}
        {eventos.map((ev) =>
          ev.tipo === 'mensagem' ? (
            <div
              key={ev.dados.id}
              className={cn('flex', ev.dados.direcao === 'in' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[80%] rounded-lg px-3 py-2 text-sm',
                  ev.dados.direcao === 'in' ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                <p className="whitespace-pre-wrap">{ev.dados.texto}</p>
                <p className="mt-1 text-[10px] opacity-60">
                  {ev.dados.direcao === 'in' ? 'contato' : 'agente'} · {ev.dados.status}
                </p>
              </div>
            </div>
          ) : (
            <p key={ev.dados.id} className="text-center text-xs text-muted-foreground">
              ⚙ turno agregado: “{ev.dados.textoAgregado.replaceAll('\n', ' · ')}”
            </p>
          ),
        )}
        <div ref={fimRef} />
      </section>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void enviar();
        }}
      >
        <input
          className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Mensagem do contato…"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={!texto.trim()}
        >
          Enviar
        </button>
      </form>
    </main>
  );
}
