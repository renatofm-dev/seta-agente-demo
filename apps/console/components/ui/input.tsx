import { cn } from '@/lib/utils';

/** Campos do design: 42px, borda clara, fundo "papel", raio 10px, foco escuro. */
const CAMPO =
  'w-full rounded-[10px] border border-line bg-background px-3.5 text-sm text-ink outline-none placeholder:text-text-3 focus:border-ink disabled:opacity-60';

export function Input({
  className,
  compacto,
  mono,
  ...props
}: React.ComponentProps<'input'> & { compacto?: boolean; mono?: boolean }) {
  return (
    <input
      className={cn(
        CAMPO,
        compacto ? 'h-9 text-[13px]' : 'h-[42px]',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(CAMPO, 'resize-none py-2.5 text-[13.5px] leading-snug', className)}
      {...props}
    />
  );
}

export function Select({
  className,
  compacto,
  children,
  ...props
}: React.ComponentProps<'select'> & { compacto?: boolean }) {
  return (
    <select
      className={cn(CAMPO, 'px-3', compacto ? 'h-9 text-[13px]' : 'h-[42px]', className)}
      {...props}
    >
      {children}
    </select>
  );
}

/** Rótulo + campo empilhados (o `label` do design). */
export function Campo({
  rotulo,
  dica,
  className,
  children,
}: {
  rotulo: React.ReactNode;
  dica?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: o campo vem em children, dentro do label
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-semibold text-text-2">{rotulo}</span>
      {children}
      {dica && <span className="text-[11px] text-text-3">{dica}</span>}
    </label>
  );
}

/** Caixa de seleção com rótulo (opção de lista, exclusões do wizard…). */
export function Opcao({
  className,
  children,
  ...props
}: React.ComponentProps<'input'> & { children: React.ReactNode }) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 text-[13px] text-text-2',
        props.disabled && 'opacity-70',
        className,
      )}
    >
      <input type="checkbox" className="mt-[3px] accent-ink" {...props} />
      <span className="flex-1">{children}</span>
    </label>
  );
}
