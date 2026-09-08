import { cn } from '@/lib/utils';

/**
 * Superfície branca com borda e raio grande — o "cartão" padrão do design.
 * `shrink-0`: dentro da coluna flex da página, um cartão com `overflow` teria
 * min-height 0 e encolheria para caber na viewport (a tabela sumia).
 */
export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) {
  return (
    <div
      className={cn('shrink-0 rounded-[14px] border border-line bg-surface', className)}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * KPI card: rótulo pequeno, número grande em Space Grotesk, nota embaixo.
 * `tom` colore o número (ok/risk) e `atencao` pinta a borda quando exige ação.
 */
export function Kpi({
  rotulo,
  valor,
  nota,
  tom,
  atencao,
  className,
}: {
  rotulo: string;
  valor: React.ReactNode;
  nota?: React.ReactNode;
  tom?: 'ok' | 'risk' | 'warn';
  atencao?: boolean;
  className?: string;
}) {
  const corValor =
    tom === 'ok' ? 'text-ok' : tom === 'risk' ? 'text-brand' : tom === 'warn' ? 'text-warn' : '';
  return (
    <Card className={cn('p-4', atencao && 'border-warn-2/35', className)}>
      <div className={cn('text-xs', atencao ? 'font-semibold text-warn' : 'text-text-3')}>
        {rotulo}
      </div>
      <div
        className={cn(
          'font-heading text-[28px] font-semibold leading-tight tracking-[-.02em]',
          corValor,
        )}
      >
        {valor}
      </div>
      {nota !== undefined && <div className="text-xs text-text-3">{nota}</div>}
    </Card>
  );
}

/** Estado vazio que ensina de onde o dado nasce, com CTA opcional. */
export function Vazio({
  titulo,
  texto,
  acao,
  className,
}: {
  titulo?: string;
  texto: React.ReactNode;
  acao?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-[14px] border border-dashed border-line-strong bg-surface p-8 text-center text-[13px] text-text-3',
        className,
      )}
    >
      {titulo && <div className="font-semibold text-text-2">{titulo}</div>}
      <div className="max-w-md">{texto}</div>
      {acao && <div className="mt-2">{acao}</div>}
    </div>
  );
}

/** Barra fina de progresso (funil das campanhas, motivos de escalada). */
export function Barra({
  fracao,
  cor = 'bg-ok',
  className,
}: {
  fracao: number;
  cor?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(fracao * 100)));
  return (
    <span className={cn('block h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3', className)}>
      <span className={cn('block h-1.5 rounded-full', cor)} style={{ width: `${pct}%` }} />
    </span>
  );
}
