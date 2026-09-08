'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Eyebrow } from './chip';

/**
 * Painel lateral direito das telas de lista (Cobranças, Leads): abre sem trocar
 * de rota, fecha no × ou com Esc. Quem controla a largura da coluna é o pai
 * (grid `1fr 400px`); aqui fica só o conteúdo.
 */
export function Drawer({
  eyebrow,
  titulo,
  subtitulo,
  aoFechar,
  className,
  children,
}: {
  eyebrow: React.ReactNode;
  titulo: React.ReactNode;
  subtitulo?: React.ReactNode;
  aoFechar: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const aoTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') aoFechar();
    };
    window.addEventListener('keydown', aoTecla);
    return () => window.removeEventListener('keydown', aoTecla);
  }, [aoFechar]);

  return (
    <aside
      className={cn(
        'flex h-full flex-col overflow-y-auto border-l border-line bg-surface',
        className,
      )}
      aria-label={typeof titulo === 'string' ? titulo : undefined}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <Eyebrow>{eyebrow}</Eyebrow>
          <div className="truncate font-heading text-2xl font-semibold tracking-[-.02em]">
            {titulo}
          </div>
          {subtitulo && <div className="text-[12.5px] text-text-2">{subtitulo}</div>}
        </div>
        <button
          type="button"
          onClick={aoFechar}
          aria-label="Fechar"
          className="flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-surface text-base text-text-3 hover:border-line-strong hover:text-ink"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-[18px] p-5">{children}</div>
    </aside>
  );
}

/** Grade rótulo/valor usada nos detalhes (Contrato, Parcelas, Método…). */
export function Detalhes({
  itens,
  className,
}: {
  itens: { rotulo: string; valor: React.ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[13px]', className)}>
      {itens.map((i) => (
        <div key={i.rotulo} className="contents">
          <span className="text-text-3">{i.rotulo}</span>
          <span className={cn('min-w-0 break-words', i.mono && 'font-mono text-xs')}>
            {i.valor}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Linha do tempo: hora à esquerda, ponto, texto; o último item em destaque. */
export function LinhaTempo({
  itens,
  className,
}: {
  itens: { hora: string; texto: React.ReactNode; tom?: 'ok' | 'risk' | 'warn' }[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col', className)}>
      {itens.map((i, idx) => {
        const ultimo = idx === itens.length - 1;
        const cor =
          i.tom === 'ok'
            ? 'bg-ok'
            : i.tom === 'risk'
              ? 'bg-brand'
              : i.tom === 'warn'
                ? 'bg-warn-2'
                : ultimo
                  ? 'bg-ink'
                  : 'bg-line-strong';
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: linha do tempo é imutável e ordenada
            key={`${i.hora}-${idx}`}
            className="grid grid-cols-[52px_12px_1fr] items-start gap-2 py-1 text-[12.5px]"
          >
            <span className="font-mono text-[11px] text-text-3">{i.hora}</span>
            <span className={cn('mt-[5px] size-2 rounded-full', cor)} />
            <span className={cn('text-text-2', ultimo && 'font-medium text-ink')}>{i.texto}</span>
          </div>
        );
      })}
    </div>
  );
}
