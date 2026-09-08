import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Botões do design: vermelho SETA para a ação primária da tela, "ink" (preto)
 * para a ação forte secundária, contorno para o resto, `danger` para o que
 * recusa/cancela. Alturas casam com o mock (30 / 34 / 38 / 44 px).
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border border-transparent font-semibold transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-brand text-white shadow-[0_8px_28px_rgba(230,51,41,.14)] hover:bg-brand-hover',
        ink: 'bg-ink text-white hover:bg-[#2a2a32]',
        outline: 'border-line bg-surface text-text-2 hover:border-line-strong hover:text-ink',
        ghost: 'text-text-2 hover:bg-surface-3 hover:text-ink',
        danger: 'border-brand/25 bg-surface text-brand hover:bg-brand/5',
        success: 'bg-ok text-white hover:bg-[#15803d]',
        link: 'h-auto px-0 text-brand underline-offset-4 hover:text-brand-hover hover:underline',
      },
      size: {
        xs: 'h-[26px] px-2.5 text-xs rounded-[8px]',
        sm: 'h-[30px] px-2.5 text-xs rounded-[8px]',
        default: 'h-[34px] px-3 text-[13px]',
        md: 'h-[38px] px-3.5 text-[13px]',
        lg: 'h-11 px-5 text-sm rounded-[10px]',
        icon: 'size-8 rounded-[8px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
