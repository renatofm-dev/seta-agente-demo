'use client';

import { Chip } from '@/components/ui/chip';
import type { TraceEvento } from '@/lib/console-api';
import { PAPEL_EVENTO } from '@/lib/rotulos';
import { cn } from '@/lib/utils';

/** Linha de eventos do turno (010): um resumo legível por evento + JSON sob demanda. */

function curto(v: unknown, max = 120): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) return '—';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const TIPOS_CONHECIDOS = new Set<string>([
  'contexto',
  'llm',
  'tool',
  'verdict',
  'fallback',
  'escalado',
  'descartado',
]);

/** Evento que o console ainda não conhece (ex.: anonimizacao): lista os campos. */
function resumoGenerico(e: Record<string, unknown>): string {
  const partes = Object.entries(e)
    .filter(([k]) => k !== 'tipo')
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v ? curto(v, 60) : String(v)}`);
  return partes.join(' · ') || String(e.tipo);
}

export function resumoEvento(e: TraceEvento): string {
  if (!TIPOS_CONHECIDOS.has(e.tipo)) return resumoGenerico(e as Record<string, unknown>);
  switch (e.tipo) {
    case 'contexto': {
      const { tipo: _tipo, ...resto } = e;
      const partes = Object.entries(resto).map(([k, v]) =>
        Array.isArray(v)
          ? `${k}: ${v.map((x) => (typeof x === 'object' && x ? curto(x, 40) : String(x))).join(', ')}`
          : typeof v === 'object' && v
            ? `${k}: ${curto(v, 60)}`
            : `${k}: ${String(v)}`,
      );
      return partes.join(' · ') || 'contexto vazio';
    }
    case 'llm': {
      const modelo = typeof e.modelo === 'string' ? `${e.modelo} · ` : '';
      return `${modelo}${e.tokensEntrada ?? '?'} in / ${e.tokensSaida ?? '?'} out${
        e.finishReason ? ` · finish: ${e.finishReason}` : ''
      }`;
    }
    case 'tool':
      return `${e.nome} · ${e.latencyMs} ms · ${curto(e.params, 80)} → ${
        e.erro ? `erro: ${e.erro}` : curto(e.resultado, 80)
      }`;
    case 'verdict':
      return `guardrail ${e.guardrail} · hook ${e.hook} · tipo ${e.verdict.tipo}${
        e.verdict.trigger ? ` · trigger "${e.verdict.trigger}"` : ''
      }${e.verdict.reason ? ` · ${e.verdict.reason}` : ''}`;
    case 'fallback':
      return `resposta de fallback · ${e.motivo}`;
    case 'escalado':
      return 'escalado para humano';
    case 'descartado':
      return `turno superado por mensagem nova (#46) · ${e.motivo}`;
  }
}

function detalheDe(e: TraceEvento): unknown {
  if (!TIPOS_CONHECIDOS.has(e.tipo)) {
    const { tipo: _tipo, ...resto } = e as Record<string, unknown>;
    return Object.keys(resto).length > 0 ? resto : null;
  }
  if (e.tipo === 'tool') return { params: e.params, resultado: e.resultado, erro: e.erro };
  if (e.tipo === 'contexto') {
    const { tipo: _tipo, ...resto } = e;
    return resto;
  }
  if (e.tipo === 'verdict') return e.verdict;
  return null;
}

export function LinhaEvento({ e }: { e: TraceEvento }) {
  const detalhe = detalheDe(e);
  return (
    <div className="grid grid-cols-[90px_1fr] items-start gap-3.5 border-t border-line-soft py-2">
      <Chip
        papel={PAPEL_EVENTO[e.tipo]}
        className="justify-center rounded-[6px] font-mono font-medium"
      >
        {e.tipo}
      </Chip>
      <div className="min-w-0 text-[13px] text-text-2">
        <span className={cn(e.tipo === 'tool' && 'break-all font-mono text-xs')}>
          {resumoEvento(e)}
        </span>
        {detalhe !== null && (
          <details className="mt-1">
            <summary className="cursor-pointer font-mono text-[10.5px] text-text-3">
              ver JSON
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-[8px] bg-surface-2 p-2 font-mono text-[11px] leading-snug">
              {JSON.stringify(detalhe, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
