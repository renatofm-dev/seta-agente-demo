'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type CobrancasResposta,
  type CobrancaView,
  STATUS_COBRANCA_LABEL,
  type StatusCobranca,
} from '@/lib/console-api';
import { dataCurta, reaisDeCentavos, telefoneBonito } from '@/lib/formatos';
import { cn } from '@/lib/utils';

/**
 * Cobranças (014): tudo que o fluxo de pagamento gerou pelo WhatsApp — com a
 * aprovação humana das que passam do teto e, em dev, o "simular pagamento"
 * que fecha o ciclo da demo (webhook → baixa → aviso ao cotista).
 */

const CHIP: Record<StatusCobranca, string> = {
  aguardando_aprovacao: 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  emitindo: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  emitida: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  paga: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  expirada: 'bg-muted text-muted-foreground',
  cancelada: 'bg-muted text-muted-foreground',
  recusada: 'bg-red-500/15 text-red-600',
  falha: 'bg-red-500/15 text-red-600',
  estornada: 'bg-red-500/15 text-red-600',
};

const METODO_LABEL = { boleto: 'Boleto', pix: 'PIX', cartao: 'Cartão' } as const;

const FILTROS: (StatusCobranca | 'todas')[] = [
  'todas',
  'aguardando_aprovacao',
  'emitida',
  'paga',
  'falha',
];

function LinhaCobranca({
  c,
  simuladorAtivo,
  aoMudar,
}: {
  c: CobrancaView;
  simuladorAtivo: boolean;
  aoMudar: (aviso: string | null) => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [recusando, setRecusando] = useState(false);
  const [motivo, setMotivo] = useState('');

  async function executar(acao: () => Promise<unknown>, okMsg: string) {
    setOcupado(true);
    try {
      await acao();
      aoMudar(okMsg);
    } catch (err) {
      aoMudar(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
      setRecusando(false);
    }
  }

  const link = c.urlBoleto ?? c.urlFatura;
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.contatoNome ?? telefoneBonito(c.waId)}</span>
        <span className="text-xs text-muted-foreground">contrato {c.contratoId}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', CHIP[c.status])}>
          {STATUS_COBRANCA_LABEL[c.status]}
        </span>
        <span className="ml-auto font-medium">{reaisDeCentavos(c.valorCentavos)}</span>
        <span className="text-xs text-muted-foreground">
          {METODO_LABEL[c.metodo]} · vence {dataCurta(c.vencimentoPsp)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {c.parcelas ?? '—'} · gerada {new Date(c.criadoEm).toLocaleString('pt-BR')}
        {c.pagoEm && <> · paga {new Date(c.pagoEm).toLocaleString('pt-BR')}</>}
      </p>
      {c.motivo && <p className="mt-1 text-xs text-red-600">{c.motivo}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="underline">
            abrir pagamento
          </a>
        )}
        {c.ticketId && (
          <Link href={`/ticket/${c.ticketId}`} className="underline">
            conversa
          </Link>
        )}
        {c.status === 'aguardando_aprovacao' && !recusando && (
          <>
            <button
              type="button"
              disabled={ocupado}
              onClick={() =>
                executar(() => api.aprovarCobranca(c.id), 'Aprovada — gerando o pagamento.')
              }
              className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-50"
            >
              Aprovar
            </button>
            <button
              type="button"
              disabled={ocupado}
              onClick={() => setRecusando(true)}
              className="rounded-md border px-2 py-1 disabled:opacity-50"
            >
              Recusar
            </button>
          </>
        )}
        {recusando && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              executar(() => api.recusarCobranca(c.id, motivo.trim()), 'Cobrança recusada.');
            }}
            className="flex flex-1 items-center gap-2"
          >
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Motivo da recusa"
              className="flex-1 rounded-md border bg-transparent px-2 py-1"
            />
            <button
              type="submit"
              disabled={ocupado || motivo.trim().length < 3}
              className="rounded-md border px-2 py-1 disabled:opacity-50"
            >
              Confirmar recusa
            </button>
            <button type="button" onClick={() => setRecusando(false)} className="px-2 py-1">
              cancelar
            </button>
          </form>
        )}
        {simuladorAtivo && c.status === 'emitida' && (
          <button
            type="button"
            disabled={ocupado}
            onClick={() =>
              executar(
                () => api.simularPagamento(c.id),
                'Pagamento simulado — aguarde o webhook fechar o ciclo.',
              )
            }
            className="ml-auto rounded-md border border-dashed px-2 py-1 disabled:opacity-50"
            title="Só em dev (DEV_SIMULATOR): marca como recebida no PSP"
          >
            Simular pagamento
          </button>
        )}
      </div>
    </div>
  );
}

export default function CobrancasPage() {
  const [dados, setDados] = useState<CobrancasResposta | null>(null);
  const [filtro, setFiltro] = useState<StatusCobranca | 'todas'>('todas');
  const [aviso, setAviso] = useState<string | null>(null);

  const recarregar = useCallback(() => {
    api
      .cobrancas(filtro === 'todas' ? undefined : filtro)
      .then(setDados)
      .catch((err) => setAviso(err instanceof Error ? err.message : String(err)));
  }, [filtro]);

  useEffect(() => {
    recarregar();
    const timer = setInterval(recarregar, 5_000); // emissão/webhook mudam status sozinhos
    return () => clearInterval(timer);
  }, [recarregar]);

  const contagens = dados?.contagens ?? {};
  return (
    <main className="mx-auto max-w-4xl space-y-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Cobranças pelo WhatsApp</h2>
        {dados && (
          <span className="text-xs text-muted-foreground">
            PSP: {dados.psp}
            {dados.psp === 'asaas' && ` (${dados.ambiente})`}
          </span>
        )}
        <div className="ml-auto flex gap-1 text-xs">
          {FILTROS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFiltro(f)}
              className={cn(
                'rounded-full border px-2 py-0.5',
                filtro === f ? 'bg-muted font-medium' : 'text-muted-foreground',
              )}
            >
              {f === 'todas' ? 'Todas' : STATUS_COBRANCA_LABEL[f]}
              {f !== 'todas' && contagens[f] ? ` (${contagens[f]})` : ''}
            </button>
          ))}
        </div>
      </div>
      {dados?.psp === 'simulado' && (
        <p className="rounded-lg border border-amber-500/60 p-2 text-xs text-amber-700">
          PSP simulado: links e códigos são fictícios. Configure ASAAS_API_KEY para usar o sandbox
          do Asaas.
        </p>
      )}
      {aviso && (
        <p className="text-xs text-muted-foreground">
          {aviso}{' '}
          <button type="button" onClick={() => setAviso(null)} className="underline">
            ok
          </button>
        </p>
      )}
      <div className="space-y-2">
        {(dados?.cobrancas ?? []).map((c) => (
          <LinhaCobranca
            key={c.id}
            c={c}
            simuladorAtivo={dados?.simuladorAtivo ?? false}
            aoMudar={(msg) => {
              setAviso(msg);
              recarregar();
            }}
          />
        ))}
        {dados && dados.cobrancas.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nenhuma cobrança ainda. Ela nasce quando um cotista diz "quero pagar" no WhatsApp.
          </p>
        )}
        {!dados && <p className="text-xs text-muted-foreground">Carregando…</p>}
      </div>
    </main>
  );
}
