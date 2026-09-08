import { porcentagem } from '@/lib/formatos';
import { cn } from '@/lib/utils';

export interface EtapaFunil {
  rotulo: string;
  n: number;
  /** Classe de fundo da barra (`bg-brand`, `bg-ok`, `bg-line-strong`…). */
  cor?: string;
}

/**
 * Funil em barras (design 5.3.3): uma coluna por etapa, altura proporcional a
 * `base` (a primeira etapa, normalmente), número grande e percentual em mono.
 * Usado no detalhe da campanha e no relatório de campanhas.
 */
export function Funil({
  etapas,
  base,
  className,
}: {
  etapas: readonly EtapaFunil[];
  /** Denominador das porcentagens e das alturas; 0 ⇒ barras mínimas. */
  base: number;
  className?: string;
}) {
  return (
    <div
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${etapas.length}, minmax(0, 1fr))` }}
    >
      {etapas.map((e) => (
        <div key={e.rotulo} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex h-16 items-end">
            <div
              className={cn('w-full rounded-[6px_6px_2px_2px]', e.cor ?? 'bg-brand')}
              style={{ height: `${base ? Math.max(6, Math.round((e.n / base) * 64)) : 6}px` }}
            />
          </div>
          <div className="font-heading text-xl font-semibold tracking-[-.02em]">{e.n}</div>
          <div className="truncate text-xs text-text-2">{e.rotulo}</div>
          <div className="font-mono text-[10.5px] text-text-3">{porcentagem(e.n, base)}</div>
        </div>
      ))}
    </div>
  );
}
