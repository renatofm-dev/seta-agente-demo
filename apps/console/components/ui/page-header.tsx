import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Eyebrow } from './chip';

/**
 * Cabeçalho das telas de lista: eyebrow com o nome da instalação, título em
 * Space Grotesk e as ações primárias à direita. `voltar` vira o link "← …".
 */
export function PageHeader({
  eyebrow,
  titulo,
  subtitulo,
  voltar,
  acoes,
  className,
}: {
  eyebrow?: React.ReactNode;
  titulo: React.ReactNode;
  subtitulo?: React.ReactNode;
  voltar?: { href: string; rotulo: string };
  acoes?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        {voltar && (
          <Link
            href={voltar.href}
            className="mb-1.5 inline-block text-[12.5px] text-text-3 hover:text-brand"
          >
            ← {voltar.rotulo}
          </Link>
        )}
        {eyebrow && !voltar && <Eyebrow className="mb-1.5">{eyebrow}</Eyebrow>}
        <h1 className="m-0 flex flex-wrap items-center gap-3 font-heading text-[26px] font-semibold leading-tight tracking-[-.02em]">
          {titulo}
        </h1>
        {subtitulo && <div className="mt-1 font-mono text-[11.5px] text-text-3">{subtitulo}</div>}
      </div>
      {acoes && <div className="flex flex-wrap gap-2">{acoes}</div>}
    </div>
  );
}

/** Container padrão das telas de lista (padding, largura máxima, rolagem própria). */
export function Pagina({
  className,
  children,
  rolagem = true,
}: {
  className?: string;
  children: React.ReactNode;
  rolagem?: boolean;
}) {
  return (
    <main
      className={cn(
        'mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-8 py-7',
        rolagem && 'h-full overflow-y-auto',
        className,
      )}
    >
      {children}
    </main>
  );
}
