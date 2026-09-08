import { cn } from '@/lib/utils';

/** Iniciais em círculo (lista de conversas, equipe). */
export function Avatar({
  iniciais,
  tom = 'claro',
  tamanho = 38,
  className,
}: {
  iniciais: string;
  tom?: 'claro' | 'escuro';
  tamanho?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-heading font-semibold',
        tom === 'escuro' ? 'bg-ink text-white' : 'bg-surface-3 text-text-2',
        className,
      )}
      style={{ width: tamanho, height: tamanho, fontSize: Math.round(tamanho / 3) }}
    >
      {iniciais}
    </span>
  );
}

/**
 * Pré-visualização de mensagem como o cotista vê no WhatsApp: fundo bege do
 * app, balão branco, rodapé cinza e horário. `*negrito*` do WhatsApp vira <b>.
 */
export function PreviewWhatsApp({
  texto,
  rodape,
  hora = '09:00',
  className,
}: {
  texto: string;
  rodape?: string | null;
  hora?: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-[18px] border border-line bg-whatsapp p-4', className)}>
      <div className="rounded-[4px_12px_12px_12px] bg-surface px-3 py-2.5 text-[13px] leading-[1.45] shadow-[0_1px_2px_rgba(20,20,22,.08)]">
        <p className="m-0 whitespace-pre-wrap break-words">{negritoWhatsApp(texto)}</p>
        {rodape && <p className="mt-1.5 mb-0 text-xs text-text-3">{rodape}</p>}
        <div className="mt-1 text-right font-mono text-[10px] text-text-3">{hora}</div>
      </div>
    </div>
  );
}

/** Troca `*trecho*` por negrito, como o WhatsApp renderiza. */
export function negritoWhatsApp(texto: string): React.ReactNode[] {
  const partes = texto.split(/(\*[^*\n]+\*)/g);
  return partes.map((p, i) =>
    p.startsWith('*') && p.endsWith('*') && p.length > 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: fragmentos estáticos do texto
      <b key={i}>{p.slice(1, -1)}</b>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: fragmentos estáticos do texto
      <span key={i}>{p}</span>
    ),
  );
}
