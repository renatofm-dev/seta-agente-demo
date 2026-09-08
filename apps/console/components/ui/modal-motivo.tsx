'use client';

import { useEffect, useState } from 'react';
import { Button } from './button';
import { Textarea } from './input';

/**
 * Confirmação com motivo obrigatório (≥ 3 caracteres): recusar cobrança,
 * rejeitar proposta, kill-switch. Substitui o window.prompt de antes.
 */
export function ModalMotivo({
  aberto,
  titulo,
  descricao,
  rotuloConfirmar,
  aoConfirmar,
  aoFechar,
}: {
  aberto: boolean;
  titulo: string;
  descricao?: React.ReactNode;
  rotuloConfirmar: string;
  aoConfirmar: (motivo: string) => Promise<void> | void;
  aoFechar: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!aberto) {
      setMotivo('');
      setErro(null);
      setOcupado(false);
    }
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    const aoTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') aoFechar();
    };
    window.addEventListener('keydown', aoTecla);
    return () => window.removeEventListener('keydown', aoTecla);
  }, [aberto, aoFechar]);

  if (!aberto) return null;

  async function confirmar() {
    setOcupado(true);
    setErro(null);
    try {
      await aoConfirmar(motivo.trim());
      aoFechar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setOcupado(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Fechar"
        onClick={aoFechar}
        className="absolute inset-0 cursor-default bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-motivo-titulo"
        className="relative flex w-full max-w-md flex-col gap-4 rounded-[14px] border border-line bg-surface p-5 shadow-[0_24px_60px_rgba(20,20,26,.18)]"
      >
        <div>
          <h2
            id="modal-motivo-titulo"
            className="m-0 font-heading text-lg font-semibold tracking-[-.02em]"
          >
            {titulo}
          </h2>
          {descricao && <p className="mt-1 text-[13px] text-text-2">{descricao}</p>}
        </div>
        <Textarea
          rows={3}
          autoFocus
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Motivo (obrigatório, mínimo 3 caracteres)"
        />
        {erro && <p className="text-xs text-brand">{erro}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={aoFechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={confirmar}
            disabled={ocupado || motivo.trim().length < 3}
          >
            {ocupado ? 'Enviando…' : rotuloConfirmar}
          </Button>
        </div>
      </div>
    </div>
  );
}
