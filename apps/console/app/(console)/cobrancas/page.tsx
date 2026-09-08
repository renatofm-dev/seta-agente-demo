'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kpi, Vazio } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { Detalhes, Drawer, LinhaTempo } from '@/components/ui/drawer';
import { ModalMotivo } from '@/components/ui/modal-motivo';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Filtros, Linha, Tabela } from '@/components/ui/tabela';
import {
  api,
  type CobrancaDetalhe,
  type CobrancasResposta,
  type CobrancaView,
  type StatusCobranca,
} from '@/lib/console-api';
import { dataCurta, dataHoraCurta, hora, nomeExibicao, reaisDeCentavos } from '@/lib/formatos';
import { METODO_COBRANCA, STATUS_COBRANCA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao, useResumo } from '../layout';

/**
 * Cobranças (014 + design 5.4): KPIs, filtros, tabela e painel lateral com
 * linha do tempo, eventos do PSP, aprovação humana acima do teto e — em dev —
 * o "simular pagamento" que fecha o ciclo da demo. Deep-link: ?k=<id>.
 */

type Filtro = 'todas' | 'aprovacao' | 'pagamento' | 'pagas' | 'falhas';
const GRUPO: Record<Filtro, readonly StatusCobranca[] | null> = {
  todas: null,
  aprovacao: ['aguardando_aprovacao'],
  pagamento: ['emitindo', 'emitida'],
  pagas: ['paga'],
  falhas: ['falha', 'recusada', 'estornada', 'expirada', 'cancelada'],
};
const COLUNAS = '1.4fr 1.3fr 1fr .8fr 1fr 1fr';

function DrawerCobranca({
  item,
  simuladorAtivo,
  tetoCentavos,
  aoFechar,
  aoMudar,
}: {
  item: CobrancaView;
  simuladorAtivo: boolean;
  tetoCentavos: number | null;
  aoFechar: () => void;
  aoMudar: (aviso: string | null) => void;
}) {
  const [detalhe, setDetalhe] = useState<CobrancaDetalhe | null>(null);
  const [recusando, setRecusando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [copiado, setCopiado] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: status/atualizadoEm disparam o refetch do detalhe
  useEffect(() => {
    api
      .cobranca(item.id)
      .then(setDetalhe)
      .catch(() => {});
  }, [item.id, item.status, item.atualizadoEm]);

  async function executar(acao: () => Promise<unknown>, okMsg: string) {
    setOcupado(true);
    try {
      await acao();
      aoMudar(okMsg);
    } catch (err) {
      aoMudar(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
    }
  }

  const c = detalhe?.cobranca;
  const s = STATUS_COBRANCA[item.status];
  const link = c?.urlBoleto ?? c?.urlFatura ?? item.urlBoleto ?? item.urlFatura;
  const codigo = c?.pixCopiaCola ?? c?.linhaDigitavel ?? null;

  const timeline: { hora: string; texto: string; tom?: 'ok' | 'risk' | 'warn' }[] = [];
  if (c) {
    timeline.push({ hora: hora(c.criadoEm), texto: 'criada pelo agente na conversa' });
    if (c.aprovadoEm) {
      timeline.push({
        hora: hora(c.aprovadoEm),
        texto: c.status === 'recusada' ? 'recusada por atendente' : 'aprovada por atendente',
        tom: c.status === 'recusada' ? 'risk' : undefined,
      });
    }
    if (c.pagoEm) {
      timeline.push({ hora: hora(c.pagoEm), texto: 'paga · baixa registrada', tom: 'ok' });
    } else if (c.status !== 'aguardando_aprovacao' && c.status !== 'recusada') {
      timeline.push({
        hora: hora(c.atualizadoEm),
        texto: `${STATUS_COBRANCA[c.status].rotulo.toLowerCase()}${c.psp ? ` (${c.psp})` : ''}`,
        tom: STATUS_COBRANCA[c.status].papel === 'risk' ? 'risk' : undefined,
      });
    }
  }

  return (
    <>
      <Drawer
        eyebrow="Cobrança"
        titulo={reaisDeCentavos(item.valorCentavos)}
        subtitulo={`${nomeExibicao(item.contatoNome, item.waId)} · contrato ${item.contratoId}`}
        aoFechar={aoFechar}
      >
        <Chip papel={s.papel} tamanho="md" className="self-start">
          {s.rotulo}
        </Chip>

        {item.status === 'aguardando_aprovacao' && (
          <div className="flex flex-col gap-2.5 rounded-[12px] border border-warn-2/35 bg-warn-2/14 p-3">
            <div className="text-[13px] text-warn">
              <b>Precisa de aprovação.</b>{' '}
              {tetoCentavos !== null
                ? `Valor acima do teto de ${reaisDeCentavos(tetoCentavos)} para emissão automática.`
                : 'Valor acima do teto para emissão automática.'}
            </div>
            <div className="flex gap-2">
              <Button
                variant="success"
                size="md"
                className="flex-1"
                disabled={ocupado}
                onClick={() =>
                  executar(() => api.aprovarCobranca(item.id), 'Aprovada — gerando o pagamento.')
                }
              >
                Aprovar e emitir
              </Button>
              <Button
                variant="danger"
                size="md"
                className="flex-1"
                disabled={ocupado}
                onClick={() => setRecusando(true)}
              >
                Recusar
              </Button>
            </div>
          </div>
        )}

        {(item.status === 'falha' || item.status === 'recusada' || item.status === 'estornada') &&
          item.motivo && (
            <div className="rounded-[12px] border border-brand/20 bg-brand/7 p-3 text-[13px] text-brand">
              <b>{s.rotulo}.</b> {item.motivo}
            </div>
          )}

        <Detalhes
          itens={[
            {
              rotulo: 'Parcelas',
              valor: detalhe ? (
                detalhe.titulos.length > 0 ? (
                  <span className="flex flex-col">
                    {detalhe.titulos.map((t) => (
                      <span key={t.tituloId}>
                        parcela {t.parcela}
                        {t.totalParcelas ? `/${t.totalParcelas}` : ''} ({t.origem}) ·{' '}
                        {reaisDeCentavos(t.valorCentavos)} · venc. orig. {dataCurta(t.vencimento)}
                      </span>
                    ))}
                  </span>
                ) : (
                  (item.parcelas ?? '—')
                )
              ) : (
                (item.parcelas ?? '…')
              ),
            },
            { rotulo: 'Método', valor: METODO_COBRANCA[item.metodo] },
            { rotulo: 'Vencimento', valor: dataCurta(item.vencimentoPsp), mono: true },
            {
              rotulo: 'PSP',
              valor: `${item.psp}${item.pspCobrancaId ? ` · ${item.pspCobrancaId}` : ''}`,
              mono: true,
            },
            { rotulo: 'Gerada', valor: dataHoraCurta(item.criadoEm), mono: true },
            {
              rotulo: 'Conversa',
              valor: <Link href={`/inbox?c=${item.conversaId}`}>abrir no atendimento →</Link>,
            },
          ]}
        />

        <div className="flex flex-col gap-2">
          <Eyebrow>Linha do tempo</Eyebrow>
          {timeline.length > 0 ? (
            <LinhaTempo itens={timeline} />
          ) : (
            <p className="m-0 text-xs text-text-3">Carregando…</p>
          )}
        </div>

        {detalhe && detalhe.eventos.length > 0 && (
          <div className="flex flex-col gap-2">
            <Eyebrow>Eventos do PSP ({item.psp})</Eyebrow>
            {detalhe.eventos.map((e) => (
              <div
                key={e.id}
                className="flex justify-between gap-2 rounded-[9px] border border-line bg-surface-2 px-2.5 py-2 font-mono text-[11px] text-text-2"
              >
                <span>{e.tipo}</span>
                <span className="truncate text-text-3">
                  {hora(e.recebidoEm)} · {e.id.slice(0, 12)}
                  {e.erro ? ' · erro' : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-[34px] items-center rounded-[9px] border border-line bg-surface px-3 text-[12.5px] font-semibold text-text-2 no-underline hover:border-line-strong"
            >
              Abrir pagamento
            </a>
          )}
          {codigo && (
            <Button
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(codigo).then(() => {
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 2_000);
                })
              }
            >
              {copiado
                ? 'Copiado ✓'
                : c?.pixCopiaCola
                  ? 'Copiar código PIX'
                  : 'Copiar linha digitável'}
            </Button>
          )}
          {simuladorAtivo && item.status === 'emitida' && (
            <Button
              variant="outline"
              className="border-dashed"
              disabled={ocupado}
              title="Só em dev (DEV_SIMULATOR): marca como recebida no PSP"
              onClick={() =>
                executar(
                  () => api.simularPagamento(item.id),
                  'Pagamento simulado — aguarde o webhook fechar o ciclo.',
                )
              }
            >
              Simular pagamento
            </Button>
          )}
        </div>
      </Drawer>
      <ModalMotivo
        aberto={recusando}
        titulo="Recusar cobrança"
        descricao="O cotista recebe um aviso de que a cobrança não foi emitida. O motivo fica no histórico."
        rotuloConfirmar="Confirmar recusa"
        aoFechar={() => setRecusando(false)}
        aoConfirmar={(motivo) =>
          executar(() => api.recusarCobranca(item.id, motivo), 'Cobrança recusada.')
        }
      />
    </>
  );
}

function CobrancasConteudo() {
  const router = useRouter();
  const params = useSearchParams();
  const instalacao = useInstalacao();
  const { recarregar: recarregarResumo } = useResumo();
  const [dados, setDados] = useState<CobrancasResposta | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [aviso, setAviso] = useState<string | null>(null);
  const k = params.get('k');

  const recarregar = useCallback(() => {
    api
      .cobrancas()
      .then(setDados)
      .catch((err) => setAviso(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    recarregar();
    const timer = setInterval(recarregar, 5_000); // emissão/webhook mudam status sozinhos
    return () => clearInterval(timer);
  }, [recarregar]);

  const todas = dados?.cobrancas ?? [];
  const contagens = dados?.contagens ?? {};
  const conta = (f: Filtro) =>
    GRUPO[f] === null
      ? Object.values(contagens).reduce((s, n) => s + (n ?? 0), 0)
      : (GRUPO[f] ?? []).reduce((s, st) => s + (contagens[st] ?? 0), 0);
  const soma = (sts: readonly StatusCobranca[]) =>
    todas.filter((c) => sts.includes(c.status)).reduce((s, c) => s + c.valorCentavos, 0);
  const lista = useMemo(
    () => (GRUPO[filtro] === null ? todas : todas.filter((c) => GRUPO[filtro]?.includes(c.status))),
    [todas, filtro],
  );
  const item = k ? (todas.find((c) => c.id === k) ?? null) : null;
  const fechar = useCallback(() => router.replace('/cobrancas'), [router]);

  const hoje = new Date();
  const pagasHoje = todas.filter((c) => {
    if (!c.pagoEm) return false;
    const d = new Date(c.pagoEm);
    return d.toDateString() === hoje.toDateString();
  });

  return (
    <div
      className={cn('grid h-full overflow-hidden', item && 'xl:grid-cols-[minmax(0,1fr)_400px]')}
    >
      <Pagina className="min-w-0">
        <PageHeader eyebrow={instalacao?.nome ?? 'Cobranças'} titulo="Cobranças" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            rotulo="Aguardando aprovação"
            valor={conta('aprovacao')}
            atencao={conta('aprovacao') > 0}
            nota={
              conta('aprovacao') > 0
                ? `${reaisDeCentavos(soma(['aguardando_aprovacao']))} · acima do teto`
                : 'nada acima do teto'
            }
          />
          <Kpi
            rotulo="Aguardando pagamento"
            valor={conta('pagamento')}
            nota={reaisDeCentavos(soma(['emitindo', 'emitida']))}
          />
          <Kpi
            rotulo="Pagas hoje"
            valor={pagasHoje.length}
            tom="ok"
            nota={reaisDeCentavos(pagasHoje.reduce((s, c) => s + c.valorCentavos, 0))}
          />
          <Kpi
            rotulo="Falhas"
            valor={contagens.falha ?? 0}
            tom={(contagens.falha ?? 0) > 0 ? 'risk' : undefined}
            nota={(contagens.falha ?? 0) > 0 ? 'precisa de ação' : 'nenhuma'}
          />
        </div>
        {dados?.psp === 'simulado' && (
          <p className="m-0 text-xs text-text-3">
            PSP simulado: links e códigos são fictícios. Configure ASAAS_API_KEY para o sandbox do
            Asaas.
          </p>
        )}
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
            { id: 'pagamento', rotulo: 'Aguardando pagamento', n: conta('pagamento') },
            { id: 'pagas', rotulo: 'Pagas', n: conta('pagas') },
            { id: 'falhas', rotulo: 'Falhas', n: conta('falhas') },
          ]}
          ativo={filtro}
          aoMudar={setFiltro}
        />
        {dados && todas.length === 0 ? (
          <Vazio
            titulo="Nenhuma cobrança ainda"
            texto='Ela nasce quando um cotista diz "quero pagar" no WhatsApp: o agente lista as parcelas, confirma o método e emite no PSP.'
          />
        ) : (
          <Tabela
            colunas={COLUNAS}
            cabecalho={['Cotista', 'Status', 'Valor', 'Método', 'Vencimento', 'Gerada']}
          >
            {lista.map((c) => {
              const s = STATUS_COBRANCA[c.status];
              return (
                <Linha
                  key={c.id}
                  colunas={COLUNAS}
                  ativa={c.id === k}
                  onClick={() => router.replace(`/cobrancas?k=${c.id}`)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {nomeExibicao(c.contatoNome, c.waId)}
                    </span>
                    <span className="block font-mono text-[11px] text-text-3">
                      contrato {c.contratoId}
                    </span>
                  </span>
                  <span>
                    <Chip papel={s.papel} tamanho="md">
                      {s.rotulo}
                    </Chip>
                  </span>
                  <span className="font-heading font-semibold">
                    {reaisDeCentavos(c.valorCentavos)}
                  </span>
                  <span className="text-text-2">{METODO_COBRANCA[c.metodo]}</span>
                  <span className="font-mono text-[11.5px] text-text-2">
                    {dataCurta(c.vencimentoPsp)}
                  </span>
                  <span className="font-mono text-[11.5px] text-text-2">
                    {dataHoraCurta(c.criadoEm)}
                  </span>
                </Linha>
              );
            })}
            {dados && lista.length === 0 && (
              <p className="m-0 p-4 text-xs text-text-3">Nenhuma cobrança neste filtro.</p>
            )}
            {!dados && <p className="m-0 p-4 text-xs text-text-3">Carregando…</p>}
          </Tabela>
        )}
      </Pagina>
      {item && (
        <div className="fixed top-14 right-0 bottom-0 z-30 w-[400px] max-w-full shadow-[-12px_0_32px_rgba(20,20,26,.12)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
          <DrawerCobranca
            item={item}
            simuladorAtivo={dados?.simuladorAtivo ?? false}
            tetoCentavos={instalacao?.alcadas.tetoAprovacaoCentavos ?? null}
            aoFechar={fechar}
            aoMudar={(msg) => {
              setAviso(msg);
              recarregar();
              recarregarResumo();
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function CobrancasPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <CobrancasConteudo />
    </Suspense>
  );
}
