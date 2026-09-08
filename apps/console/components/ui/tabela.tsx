import { cn } from '@/lib/utils';
import { Card } from './card';

/**
 * Tabela em grid (não <table>): cabeçalho mono em caixa alta e linhas com
 * hover; `colunas` é o `grid-template-columns` do design de cada tela.
 * Larguras mínimas rolam dentro do cartão, nunca a página.
 */
export function Tabela({
  colunas,
  cabecalho,
  minWidth = 760,
  className,
  children,
}: {
  colunas: string;
  cabecalho: React.ReactNode[];
  minWidth?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn('overflow-x-auto', className)}>
      <div style={{ minWidth }}>
        <div
          className="grid gap-3 border-b border-line px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-[.08em] text-text-3"
          style={{ gridTemplateColumns: colunas }}
        >
          {cabecalho.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cabeçalho fixo por tela
            <span key={i}>{c}</span>
          ))}
        </div>
        {children}
      </div>
    </Card>
  );
}

export function Linha({
  colunas,
  ativa,
  onClick,
  className,
  children,
}: {
  colunas: string;
  ativa?: boolean;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const classes = cn(
    'grid w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left text-[13px]',
    onClick && 'cursor-pointer hover:bg-background',
    ativa && 'bg-background',
    className,
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={classes}
        style={{ gridTemplateColumns: colunas }}
      >
        {children}
      </button>
    );
  }
  return (
    <div className={classes} style={{ gridTemplateColumns: colunas }}>
      {children}
    </div>
  );
}

/** Chips de filtro com contagem; um ativo por vez. */
export function Filtros<T extends string>({
  itens,
  ativo,
  aoMudar,
  className,
}: {
  itens: { id: T; rotulo: string; n?: number }[];
  ativo: T;
  aoMudar: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {itens.map((f) => {
        const on = f.id === ativo;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => aoMudar(f.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors',
              on
                ? 'border-ink bg-ink text-white'
                : 'border-line bg-surface text-text-2 hover:border-line-strong',
            )}
          >
            {f.rotulo}
            {f.n !== undefined && (
              <span className={cn('font-mono text-[10.5px]', on ? 'opacity-80' : 'text-text-3')}>
                {f.n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Abas discretas (painel de contexto, Configurações). */
export function Abas<T extends string>({
  itens,
  ativa,
  aoMudar,
  className,
}: {
  itens: { id: T; rotulo: string }[];
  ativa: T;
  aoMudar: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex border-b border-line px-2', className)}>
      {itens.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => aoMudar(t.id)}
          className={cn(
            'h-11 flex-1 border-b-2 text-[12.5px] font-semibold transition-colors',
            ativa === t.id
              ? 'border-brand text-ink'
              : 'border-transparent text-text-3 hover:text-ink',
          )}
        >
          {t.rotulo}
        </button>
      ))}
    </div>
  );
}
