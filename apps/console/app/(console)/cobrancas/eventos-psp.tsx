'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, Vazio } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { api, type EventoPspView } from '@/lib/console-api';
import { dataHoraCurta } from '@/lib/formatos';

/**
 * Eventos do PSP que não foram processados (042).
 *
 * Existe separado do drawer da cobrança porque um evento pendente pode não
 * pertencer a cobrança nenhuma: quando o `payment.id` não resolve, ele fica
 * com `erro = 'cobrança desconhecida'` e nenhum drawer o alcança. Esta é a
 * única superfície que enxerga esses órfãos — e a única de onde dá para
 * reprocessá-los.
 */
export function PainelEventosPsp({ aoMudar }: { aoMudar: (msg: string) => void }) {
  const [eventos, setEventos] = useState<EventoPspView[] | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const recarregar = useCallback(() => {
    api
      .eventosPsp(true)
      .then((r) => setEventos(r.eventos))
      .catch((err: Error) => aoMudar(err.message));
  }, [aoMudar]);

  useEffect(recarregar, [recarregar]);

  async function reprocessar(id: string) {
    setOcupado(id);
    try {
      const r = await api.reprocessarEventoPsp(id);
      aoMudar(
        r.reenfileirado
          ? 'Evento reenfileirado — acompanhe pelo estado abaixo.'
          : (r.motivo ?? 'Nada a fazer: o evento já foi processado.'),
      );
      recarregar();
    } catch (err) {
      aoMudar((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  if (eventos !== null && eventos.length === 0) {
    return (
      <Vazio
        titulo="Nenhum evento preso"
        texto="Todo evento recebido do PSP foi processado. Eventos que falharem aparecem aqui com o motivo."
      />
    );
  }

  return (
    <Card className="flex flex-col gap-2 p-4">
      <Eyebrow>Eventos do PSP não processados</Eyebrow>
      {eventos === null ? (
        <p className="m-0 text-xs text-text-3">carregando…</p>
      ) : (
        eventos.map((e) => (
          <div
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-line bg-surface-2 px-2.5 py-2"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2 font-mono text-[11px] text-text-2">
                <span>{e.tipo}</span>
                <span className="text-text-3">{dataHoraCurta(e.recebidoEm)}</span>
                {e.pspCobrancaId && <span className="truncate text-text-3">{e.pspCobrancaId}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Chip papel={e.erro ? 'risk' : 'warn'}>{e.erro ?? 'na fila'}</Chip>
                {e.cobrancaId ? (
                  <a className="text-[11px] underline" href={`/cobrancas?k=${e.cobrancaId}`}>
                    ver cobrança
                  </a>
                ) : (
                  <span className="text-[11px] text-text-3">sem cobrança correspondente</span>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="xs"
              disabled={ocupado !== null}
              onClick={() => reprocessar(e.id)}
            >
              {ocupado === e.id ? 'Reprocessando…' : 'Reprocessar'}
            </Button>
          </div>
        ))
      )}
    </Card>
  );
}
