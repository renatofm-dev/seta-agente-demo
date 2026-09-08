'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type TraceEvento, type TraceTurnoView } from '@/lib/console-api';
import { cn } from '@/lib/utils';

/**
 * Trace viewer (010): timeline expansível por turno — contexto, tool calls
 * (params → resultado mascarado), verdicts, resposta, tokens e latência.
 * Reconstitui qualquer turno da demo sem consultar o banco na mão.
 */

function Json({ valor }: { valor: unknown }) {
  return (
    <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/60 p-2 text-[11px] leading-snug">
      {JSON.stringify(valor, null, 2)}
    </pre>
  );
}

function Evento({ e }: { e: TraceEvento }) {
  if (e.tipo === 'contexto') {
    const { tipo: _tipo, ...resto } = e;
    return (
      <li className="rounded border border-dashed p-2">
        <span className="font-medium text-muted-foreground">contexto</span>
        <Json valor={resto} />
      </li>
    );
  }
  if (e.tipo === 'llm') {
    const chamada = e as { tokensEntrada?: number; tokensSaida?: number; finishReason?: string };
    return (
      <li className="rounded border p-2">
        <span className="font-medium">llm</span>
        {typeof chamada.tokensEntrada === 'number' && (
          <span className="ml-2 text-muted-foreground">
            {chamada.tokensEntrada}/{chamada.tokensSaida ?? 0} tok
          </span>
        )}
        {chamada.finishReason && (
          <span className="ml-2 text-muted-foreground">{chamada.finishReason}</span>
        )}
      </li>
    );
  }
  if (e.tipo === 'tool') {
    return (
      <li className={cn('rounded border p-2', e.erro && 'border-red-400')}>
        <span className="font-medium">tool · {e.nome}</span>
        <span className="ml-2 text-muted-foreground">{e.latencyMs} ms</span>
        {e.erro && <span className="ml-2 text-red-600">erro: {e.erro}</span>}
        <p className="mt-1 text-muted-foreground">params → resultado (mascarado)</p>
        <Json valor={e.params} />
        <Json valor={e.resultado} />
      </li>
    );
  }
  if (e.tipo === 'verdict') {
    return (
      <li className="rounded border border-amber-400/60 p-2">
        <span className="font-medium">verdict · {e.guardrail}</span>
        <span className="ml-2">
          {e.hook} → <b>{e.verdict.tipo}</b>
          {e.verdict.trigger ? ` (${e.verdict.trigger})` : ''}
        </span>
        {(e.verdict.reason ?? e.verdict.patch) && (
          <p className="mt-1 text-muted-foreground">{e.verdict.reason ?? e.verdict.patch}</p>
        )}
      </li>
    );
  }
  if (e.tipo === 'fallback') {
    return (
      <li className="rounded border border-red-400/60 p-2">
        <span className="font-medium">fallback</span>
        <span className="ml-2 text-muted-foreground">{e.motivo}</span>
      </li>
    );
  }
  if (e.tipo === 'descartado') {
    return (
      <li className="rounded border border-dashed border-sky-400/60 p-2">
        <span className="font-medium">turno superado (#46)</span>
        <span className="ml-2 text-muted-foreground">{e.motivo}</span>
      </li>
    );
  }
  return (
    <li className="rounded border border-amber-400/60 p-2">
      <span className="font-medium">escalado para humano</span>
    </li>
  );
}

export function TraceViewer({ ticketId }: { ticketId: string }) {
  const [traces, setTraces] = useState<TraceTurnoView[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(() => {
    api
      .traces(ticketId)
      .then((r) => setTraces(r.traces))
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, [ticketId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (erro) return <p className="p-3 text-xs text-red-600">{erro}</p>;
  if (!traces) return <p className="p-3 text-xs text-muted-foreground">Carregando trace…</p>;
  if (traces.length === 0)
    return <p className="p-3 text-xs text-muted-foreground">Sem turnos processados ainda.</p>;

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground">
          {traces.length} turno(s) — clique para expandir a decisão inteira
        </p>
        <button type="button" onClick={carregar} className="rounded border px-2 py-0.5">
          Atualizar
        </button>
      </div>
      {traces.map((t, i) => (
        <details key={t.id} className="rounded-md border">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
            <span className="font-medium">Turno {i + 1}</span>
            <span className="max-w-[40%] truncate text-muted-foreground">
              “{t.textoTurno ?? '—'}”
            </span>
            <span className="ml-auto flex items-center gap-2 text-muted-foreground">
              {t.escalado && (
                <span className="rounded bg-amber-500/15 px-1.5 text-amber-700">escalado</span>
              )}
              {t.fallback && (
                <span className="rounded bg-red-500/15 px-1.5 text-red-700">fallback</span>
              )}
              <span>
                {t.tokensEntrada}/{t.tokensSaida} tok
              </span>
              <span>{t.latenciaMs} ms</span>
              <span>{new Date(t.criadoEm).toLocaleTimeString('pt-BR')}</span>
            </span>
          </summary>
          <div className="space-y-2 border-t px-3 py-2">
            <p className="text-muted-foreground">
              traceId <code>{t.traceId}</code>
              {t.fallbackMotivo ? ` · motivo do fallback: ${t.fallbackMotivo}` : ''}
            </p>
            <ol className="space-y-1">
              <Evento e={{ tipo: 'contexto', ...t.contexto }} />
              {t.eventos
                .filter((e) => e.tipo !== 'contexto')
                .map((e, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: eventos são imutáveis e ordenados
                  <Evento key={j} e={e} />
                ))}
            </ol>
            <div className="rounded border border-emerald-500/40 p-2">
              <span className="font-medium">resposta</span>
              <p className="mt-1 whitespace-pre-wrap">{t.resposta}</p>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
