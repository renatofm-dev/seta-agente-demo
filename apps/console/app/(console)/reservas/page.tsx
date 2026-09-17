'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kpi, Vazio } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Detalhes, Drawer } from '@/components/ui/drawer';
import { ModalMotivo } from '@/components/ui/modal-motivo';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Filtros, Linha, Tabela } from '@/components/ui/tabela';
import {
  api,
  type ReservaDetalhe,
  type ReservasResposta,
  type ReservaView,
  type StatusReserva,
} from '@/lib/console-api';
import { dataCurta, dataHoraCurta, reaisDeCentavos } from '@/lib/formatos';
import { STATUS_RESERVA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao, useResumo } from '../layout';

/**
 * Reservas (038): KPIs, filtros, tabela e painel lateral com a aprovação da taxa
 * de manutenção. Deep-link `?k=<id>`, no mesmo desenho de Cobranças.
 *
 * O KPI que importa não é o de confirmadas: é **"criada, não confirmada"** — ali
 * a utilização EXISTE no TSE segurando pontos do cotista e ninguém confirmou.
 */

type Filtro = 'todas' | 'aprovacao' | 'atencao' | 'confirmadas' | 'falhas';
const GRUPO: Record<Filtro, readonly StatusReserva[] | null> = {
  todas: null,
  aprovacao: ['aguardando_aprovacao'],
  atencao: ['criando', 'criada'],
  confirmadas: ['confirmada'],
  falhas: ['falha', 'recusada', 'cancelada'],
};
const COLUNAS = '1.3fr 1.4fr 1.1fr .8fr 1fr 1fr';

const periodo = (r: ReservaView) => `${dataCurta(r.checkIn)} → ${dataCurta(r.checkOut)}`;

function DrawerReserva({
  item,
  tetoCentavos,
  aoFechar,
  aoMudar,
}: {
  item: ReservaView;
  tetoCentavos: number | null;
  aoFechar: () => void;
  aoMudar: (msg: string | null) => void;
}) {
  const [detalhe, setDetalhe] = useState<ReservaDetalhe | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recusando, setRecusando] = useState(false);

  useEffect(() => {
    setDetalhe(null);
    api
      .reserva(item.id)
      .then(setDetalhe)
      .catch(() => setDetalhe(null));
  }, [item.id]);

  const executar = async (acao: () => Promise<unknown>, okMsg: string) => {
    setOcupado(true);
    try {
      await acao();
      aoMudar(okMsg);
    } catch (err) {
      aoMudar(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
    }
  };

  const s = STATUS_RESERVA[item.status];
  const hospedes = detalhe?.reserva.hospedes ?? item.hospedes;
  const escrita = detalhe?.escrita ?? null;

  return (
    <Drawer
      eyebrow="Reserva"
      titulo={periodo(item)}
      subtitulo={`${item.hotel ?? '—'} · ${item.tipoUh ?? '—'}`}
      aoFechar={aoFechar}
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <Chip papel={s.papel} tamanho="md">
            {s.rotulo}
          </Chip>
          {item.status === 'criada' && (
            <span className="text-[11px] text-warn">
              existe no ERP e não foi confirmada — não cancele sem conferir
            </span>
          )}
        </div>

        <Detalhes
          itens={[
            { rotulo: 'Contrato', valor: item.contratoId, mono: true },
            { rotulo: 'Período', valor: periodo(item) },
            {
              rotulo: 'Pessoas',
              valor: `${item.adultos} adulto(s)${item.criancas > 0 ? ` · ${item.criancas} criança(s)` : ''}`,
            },
            { rotulo: 'Pontos', valor: item.custoPontos.toLocaleString('pt-BR') },
            { rotulo: 'Taxa de manutenção', valor: reaisDeCentavos(item.taxaCentavos) },
            {
              rotulo: 'Nº no ERP',
              valor: item.erpUtilizacaoId ?? '—',
              mono: true,
            },
            { rotulo: 'Criada', valor: dataHoraCurta(item.criadoEm) },
            ...(item.aprovadoPor
              ? [{ rotulo: 'Aprovada por', valor: item.aprovadoPor, mono: true }]
              : []),
            ...(item.motivo ? [{ rotulo: 'Motivo', valor: item.motivo }] : []),
          ]}
        />

        <div>
          <p className="m-0 mb-1.5 text-[11px] text-text-3">Hóspedes</p>
          {hospedes.length === 0 ? (
            <p className="m-0 text-xs text-text-3">Nenhum informado.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
              {hospedes.map((h) => (
                <li key={`${h.nome}-${h.cpf ?? ''}`} className="flex items-center gap-2">
                  <span>
                    {h.nome}
                    {h.sobrenome ? ` ${h.sobrenome}` : ''}
                  </span>
                  {h.principal && <Chip papel="info">principal</Chip>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {escrita && (
          <Detalhes
            className="border-line border-t pt-3"
            itens={[
              { rotulo: 'Escrita no ERP', valor: escrita.estado },
              { rotulo: 'Tentativas', valor: String(escrita.tentativas) },
              ...(escrita.erro ? [{ rotulo: 'Último erro', valor: escrita.erro }] : []),
            ]}
          />
        )}

        {item.status === 'aguardando_aprovacao' && (
          <div className="flex flex-col gap-2 border-line border-t pt-3">
            <p className="m-0 text-xs text-text-2">
              A taxa de manutenção ({reaisDeCentavos(item.taxaCentavos)}) está acima do teto
              {tetoCentavos !== null ? ` de ${reaisDeCentavos(tetoCentavos)}` : ''}. Aprovar
              registra a reserva no ERP.
            </p>
            <div className="flex gap-2">
              <Button
                disabled={ocupado}
                onClick={() =>
                  executar(
                    () => api.aprovarReserva(item.id),
                    'Reserva aprovada — registrando no ERP',
                  )
                }
              >
                Aprovar
              </Button>
              <Button variant="ghost" disabled={ocupado} onClick={() => setRecusando(true)}>
                Recusar
              </Button>
            </div>
          </div>
        )}

        <Link
          href={`/inbox?c=${item.conversaId}`}
          className="text-[12px] text-text-2 underline underline-offset-2"
        >
          Abrir a conversa
        </Link>
      </div>

      <ModalMotivo
        aberto={recusando}
        titulo="Recusar reserva"
        descricao="O cotista recebe um aviso de que a reserva não pôde ser confirmada."
        rotuloConfirmar="Recusar"
        aoFechar={() => setRecusando(false)}
        aoConfirmar={async (motivo) => {
          setRecusando(false);
          await executar(() => api.recusarReserva(item.id, motivo), 'Reserva recusada');
        }}
      />
    </Drawer>
  );
}

function ReservasConteudo() {
  const router = useRouter();
  const params = useSearchParams();
  const instalacao = useInstalacao();
  const { recarregar: recarregarResumo } = useResumo();
  const [dados, setDados] = useState<ReservasResposta | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [aviso, setAviso] = useState<string | null>(null);
  const k = params.get('k');

  const recarregar = useCallback(() => {
    api
      .reservas()
      .then(setDados)
      .catch((err) => setAviso(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    recarregar();
    // o worker muda o status sozinho (criando → criada → confirmada)
    const timer = setInterval(recarregar, 5_000);
    return () => clearInterval(timer);
  }, [recarregar]);

  const aoMudar = useCallback(
    (msg: string | null) => {
      setAviso(msg);
      recarregar();
      recarregarResumo();
    },
    [recarregar, recarregarResumo],
  );

  const todas = dados?.reservas ?? [];
  const contagens = dados?.contagens ?? {};
  const conta = (f: Filtro) =>
    GRUPO[f] === null
      ? Object.values(contagens).reduce((s: number, n) => s + (n ?? 0), 0)
      : (GRUPO[f] ?? []).reduce((s, st) => s + (contagens[st] ?? 0), 0);
  const lista = useMemo(
    () => (GRUPO[filtro] === null ? todas : todas.filter((r) => GRUPO[filtro]?.includes(r.status))),
    [todas, filtro],
  );
  const item = k ? (todas.find((r) => r.id === k) ?? null) : null;
  const fechar = useCallback(() => router.replace('/reservas'), [router]);
  const naoConfirmadas = contagens.criada ?? 0;

  return (
    <div
      className={cn('grid h-full overflow-hidden', item && 'xl:grid-cols-[minmax(0,1fr)_400px]')}
    >
      <Pagina className="min-w-0">
        <PageHeader eyebrow={instalacao?.nome ?? 'Reservas'} titulo="Reservas" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            rotulo="Aguardando aprovação"
            valor={conta('aprovacao')}
            atencao={conta('aprovacao') > 0}
            nota={conta('aprovacao') > 0 ? 'taxa acima do teto' : 'nada acima do teto'}
          />
          <Kpi
            rotulo="Criadas, não confirmadas"
            valor={naoConfirmadas}
            tom={naoConfirmadas > 0 ? 'risk' : undefined}
            nota={naoConfirmadas > 0 ? 'existem no ERP segurando pontos' : 'nenhuma'}
          />
          <Kpi rotulo="Confirmadas" valor={conta('confirmadas')} tom="ok" />
          <Kpi
            rotulo="Falhas"
            valor={contagens.falha ?? 0}
            tom={(contagens.falha ?? 0) > 0 ? 'risk' : undefined}
            nota={(contagens.falha ?? 0) > 0 ? 'precisa de ação' : 'nenhuma'}
          />
        </div>
        {aviso && (
          <p className="m-0 text-xs text-text-2">
            {aviso}{' '}
            <button type="button" onClick={() => setAviso(null)} className="underline">
              ok
            </button>
          </p>
        )}
        <Filtros<Filtro>
          itens={[
            { id: 'todas', rotulo: 'Todas', n: conta('todas') },
            { id: 'aprovacao', rotulo: 'Aguardando aprovação', n: conta('aprovacao') },
            { id: 'atencao', rotulo: 'Em registro', n: conta('atencao') },
            { id: 'confirmadas', rotulo: 'Confirmadas', n: conta('confirmadas') },
            { id: 'falhas', rotulo: 'Falhas', n: conta('falhas') },
          ]}
          ativo={filtro}
          aoMudar={setFiltro}
        />
        {dados && todas.length === 0 ? (
          <Vazio
            titulo="Nenhuma reserva ainda"
            texto='Ela nasce quando um cotista diz "quero usar minha semana" no WhatsApp: o agente consulta pontos e taxa no ERP, confirma com ele e registra a utilização.'
          />
        ) : (
          <Tabela
            colunas={COLUNAS}
            cabecalho={['Contrato', 'Período', 'Status', 'Pontos', 'Taxa', 'Criada']}
          >
            {lista.map((r) => {
              const s = STATUS_RESERVA[r.status];
              return (
                <Linha
                  key={r.id}
                  colunas={COLUNAS}
                  ativa={r.id === k}
                  onClick={() => router.replace(`/reservas?k=${r.id}`)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">contrato {r.contratoId}</span>
                    <span className="block font-mono text-[11px] text-text-3">
                      {r.hotel ?? '—'} · {r.tipoUh ?? '—'}
                    </span>
                  </span>
                  <span className="font-mono text-[11.5px] text-text-2">{periodo(r)}</span>
                  <span>
                    <Chip papel={s.papel} tamanho="md">
                      {s.rotulo}
                    </Chip>
                  </span>
                  <span className="font-heading font-semibold">
                    {r.custoPontos.toLocaleString('pt-BR')}
                  </span>
                  <span className="text-text-2">{reaisDeCentavos(r.taxaCentavos)}</span>
                  <span className="font-mono text-[11.5px] text-text-2">
                    {dataHoraCurta(r.criadoEm)}
                  </span>
                </Linha>
              );
            })}
            {dados && lista.length === 0 && (
              <p className="m-0 p-4 text-xs text-text-3">Nenhuma reserva neste filtro.</p>
            )}
            {!dados && <p className="m-0 p-4 text-xs text-text-3">Carregando…</p>}
          </Tabela>
        )}
      </Pagina>
      {item && (
        <div className="fixed top-14 right-0 bottom-0 z-30 w-[400px] max-w-full shadow-[-12px_0_32px_rgba(20,20,26,.12)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
          <DrawerReserva
            item={item}
            tetoCentavos={instalacao?.alcadas.tetoTaxaReservaCentavos ?? null}
            aoFechar={fechar}
            aoMudar={aoMudar}
          />
        </div>
      )}
    </div>
  );
}

export default function ReservasPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <ReservasConteudo />
    </Suspense>
  );
}
