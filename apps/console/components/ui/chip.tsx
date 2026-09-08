import { cn } from '@/lib/utils';

/** Papel semântico dos chips e balões (design › ROLE): nunca só cor, sempre rótulo. */
export type Papel = 'ok' | 'warn' | 'risk' | 'info' | 'off';

export const PAPEL_CLASSES: Record<Papel, string> = {
  ok: 'bg-ok/8 text-ok border-ok/22',
  warn: 'bg-warn-2/14 text-warn border-warn-2/35',
  risk: 'bg-brand/7 text-brand border-brand/20',
  info: 'bg-info-2/8 text-info border-info-2/25',
  off: 'bg-surface-2 text-text-3 border-line',
};

export function Chip({
  papel = 'off',
  tamanho = 'sm',
  className,
  children,
}: {
  papel?: Papel;
  tamanho?: 'sm' | 'md';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-semibold',
        tamanho === 'sm' ? 'h-5 px-2 text-[11px]' : 'h-[22px] px-2.5 text-[11.5px]',
        PAPEL_CLASSES[papel],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Rótulo de seção: mono, caixa alta, cinza — "IDENTIFICAÇÃO", "FUNIL DA CAMPANHA"… */
export function Eyebrow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('font-mono text-[10.5px] uppercase tracking-[.1em] text-text-3', className)}>
      {children}
    </div>
  );
}

/** Ponto de status (verde = ok, vermelho = problema, âmbar pulsando = esperando). */
export function Ponto({
  tom,
  pulsa,
  className,
}: {
  tom: 'ok' | 'risk' | 'warn' | 'off';
  pulsa?: boolean;
  className?: string;
}) {
  const cor = { ok: 'bg-ok', risk: 'bg-brand', warn: 'bg-warn', off: 'bg-text-3' }[tom];
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        cor,
        pulsa && 'animate-pulse',
        className,
      )}
    />
  );
}
