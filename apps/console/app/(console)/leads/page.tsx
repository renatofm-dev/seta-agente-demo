'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Vazio } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { Drawer, LinhaTempo } from '@/components/ui/drawer';
import { ModalMotivo } from '@/components/ui/modal-motivo';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Filtros, Linha, Tabela } from '@/components/ui/tabela';
import { api, type LeadDetalhe, type LeadView, type PerfilLead } from '@/lib/console-api';
import {
  dataHoraCurta,
  hora,
  reaisDeCentavos,
  telefoneBonito,
  telefoneMascarado,
  tempoRelativo,
} from '@/lib/formatos';
import { estadoLead, STATUS_PROPOSTA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao, useResumo } from '../layout';

/**
 * Leads (design 5.5, leitura da 015a): quem perguntou preço sem vínculo, o
 * que o SDR registrou (perfil, cota, proposta, pedido) e o histórico da
 * negociação. Aprovar/contra-propor/recusar mexem no fluxo e avisam o lead —
 * ficam com a 015b; aqui a ação é abrir a conversa. Deep-link: ?l=<id>.
 */

type Filtro = 'todos' | 'aprovacao' | 'qualificando' | 'proposta' | 'agendados' | 'perdidos';
const COLUNAS = '1.2fr 1.3fr .9fr .8fr 1.1fr 2fr';

function grupoDe(l: LeadView): Filtro {
  if (l.proposta?.status === 'aguardando_aprovacao') return 'aprovacao';
  if (l.status === 'agendado') return 'agendados';
  if (l.status === 'perdido') return 'perdidos';
  if (l.status === 'proposta') return 'proposta';
  return 'qualificando';
}

/**
 * 015b: "180000,00" / "180.000,00" / "180000" → centavos. Devolve null no que
 * não for número — o botão fica desabilitado em vez de mandar lixo ao server,
 * que valida de novo contra piso e tabela.
 */
function centavosDoTexto(texto: string): number | null {
  const limpo = texto.trim().replaceAll('.', '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;
  const n = Math.round(Number(limpo) * 100);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function perfilTexto(p: PerfilLead): string {
  if (p.pessoas === null && p.periodos === null) return '—';
  return `${p.pessoas ?? '?'} pessoas · ${p.periodos ? `${p.periodos}×/ano` : '?'}`;
}

function pedidoTexto(l: LeadView): string {
  const p = l.proposta;
  if (p?.status === 'aguardando_aprovacao' && p.valorPedidoCentavos !== null) {
    return `pediu ${reaisDeCentavos(p.valorPedidoCentavos)} (tabela ${reaisDeCentavos(p.valorTabelaCentavos)})`;
  }
  if (l.status === 'agendado')
    return l.perfil.contato ? `"${l.perfil.contato}"` : 'agendamento registrado';
  if (l.status === 'perdido') return p?.motivo ?? '—';
  if (p)
    return `ofertada ${reaisDeCentavos(p.valorOfertadoCentavos)} (${p.descontoBps > 0 ? 'piso' : 'tabela'})`;
  return '—';
}

function DrawerLead({
  item,
  aoFechar,
  aoMudar,
}: {
  item: LeadView;
  aoFechar: () => void;
  aoMudar: (msg: string | null) => void;
}) {
  const [detalhe, setDetalhe] = useState<LeadDetalhe | null>(null);
  // 015b: estado dos três botões
  const [ocupado, setOcupado] = useState(false);
  const [recusando, setRecusando] = useState(false);
  const [contrapondo, setContrapondo] = useState(false);
  const [valorContra, setValorContra] = useState('');
  useEffect(() => {
    setDetalhe(null);
    api
      .lead(item.id)
      .then(setDetalhe)
      .catch(() => {});
  }, [item.id]);

  const estado = estadoLead(item.status, item.proposta);
  const p = item.proposta;

  /** Os três caminhos da decisão; o server valida de novo e pode devolver 400/409. */
  async function decidir(qual: 'aprovar' | 'recusar' | 'contrapor', motivo?: string) {
    if (!p) return;
    setOcupado(true);
    try {
      if (qual === 'aprovar') {
        await api.aprovarProposta(item.id, p.id);
        aoMudar('Aprovado — o lead já foi avisado.');
      } else if (qual === 'recusar') {
        await api.recusarProposta(item.id, p.id, motivo ?? '');
        aoMudar('Recusado — o lead recebeu o valor do piso.');
      } else {
        const centavos = centavosDoTexto(valorContra);
        if (centavos === null) return;
        await api.contrapropor(item.id, p.id, centavos);
        aoMudar('Contra-proposta enviada ao lead.');
        setContrapondo(false);
        setValorContra('');
      }
    } catch (err) {
      aoMudar(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
      setRecusando(false);
    }
  }
  const bpsAbaixo =
    p?.valorPedidoCentavos !== null &&
    p?.valorPedidoCentavos !== undefined &&
    p.valorTabelaCentavos > 0
      ? Math.round(
          ((p.valorTabelaCentavos - p.valorPedidoCentavos) / p.valorTabelaCentavos) * 10_000,
        )
      : null;
  const pisoPct = p ? `−${(p.descontoBps / 100).toString().replace('.', ',')}%` : '';

  const historico = (detalhe?.propostas ?? []).flatMap((pr) => {
    const itens: { hora: string; texto: string; tom?: 'ok' | 'risk' | 'warn' }[] = [
      {
        hora: pr.criadoEm ? hora(pr.criadoEm) : '—',
        texto: `ofertada ${reaisDeCentavos(pr.valorOfertadoCentavos)} · ${pr.descontoBps > 0 ? 'piso' : 'tabela'} · cota ${pr.cotaCodigo}`,
      },
    ];
    if (pr.status === 'aguardando_aprovacao' && pr.valorPedidoCentavos !== null) {
      itens.push({
        hora: hora(pr.atualizadoEm),
        texto: `pediu ${reaisDeCentavos(pr.valorPedidoCentavos)} · acima da alçada · aguardando aprovação`,
        tom: 'warn',
      });
    } else if (pr.status === 'aceita') {
      itens.push({
        hora: hora(pr.atualizadoEm),
        texto: 'aceita · agendamento registrado',
        tom: 'ok',
      });
    } else if (pr.status === 'recusada' || pr.status === 'expirada') {
      itens.push({
        hora: hora(pr.atualizadoEm),
        texto: `${STATUS_PROPOSTA[pr.status].rotulo.toLowerCase()}${pr.motivo ? ` · ${pr.motivo}` : ''}`,
        tom: 'risk',
      });
    }
    return itens;
  });

  return (
    <Drawer
      eyebrow="Lead"
      titulo={item.nome ?? telefoneBonito(item.waId)}
      subtitulo={`chegou ${dataHoraCurta(item.criadoEm)} · ${perfilTexto(item.perfil)}${item.nome ? ` · ${telefoneBonito(item.waId)}` : ''}`}
      aoFechar={aoFechar}
    >
      <Chip papel={estado.papel} tamanho="md" className="self-start">
        {estado.rotulo}
      </Chip>

      {p ? (
        <div className="flex flex-col gap-2">
          <Eyebrow>Negociação · cota {p.cotaCodigo}</Eyebrow>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[9px] border border-line p-2.5">
              <div className="text-[11px] text-text-3">Tabela</div>
              <div className="font-heading text-sm font-semibold">
                {reaisDeCentavos(p.valorTabelaCentavos)}
              </div>
            </div>
            <div className="rounded-[9px] border border-line p-2.5">
              <div className="text-[11px] text-text-3">Piso do agente ({pisoPct})</div>
              <div className="font-heading text-sm font-semibold">
                {reaisDeCentavos(p.valorMinimoCentavos)}
              </div>
            </div>
            {p.valorPedidoCentavos !== null && (
              <div className="col-span-2 flex items-center justify-between rounded-[9px] border border-warn-2/35 bg-warn-2/14 p-2.5">
                <div>
                  <div className="text-[11px] text-warn">Pedido do lead</div>
                  <div className="font-heading text-base font-semibold text-warn">
                    {reaisDeCentavos(p.valorPedidoCentavos)}
                  </div>
                </div>
                {bpsAbaixo !== null && (
                  <span className="font-mono text-[11px] text-warn">{bpsAbaixo} bps abaixo</span>
                )}
              </div>
            )}
          </div>
          {p.status === 'aguardando_aprovacao' && (
            <div className="flex flex-col gap-2">
              <div className="rounded-[10px] border border-info-2/25 bg-info-2/8 px-3 py-2.5 text-[12.5px] text-info">
                O lead está esperando. Decida aqui e ele recebe a resposta no WhatsApp.
              </div>
              {contrapondo ? (
                <div className="flex flex-col gap-2 rounded-[10px] border border-line p-2.5">
                  <label
                    htmlFor="contraproposta"
                    className="text-[11px] tracking-wide text-text-3 uppercase"
                  >
                    Contra-proposta (entre {reaisDeCentavos(p.valorMinimoCentavos)} e{' '}
                    {reaisDeCentavos(p.valorTabelaCentavos)})
                  </label>
                  <input
                    id="contraproposta"
                    inputMode="decimal"
                    placeholder="180000,00"
                    value={valorContra}
                    onChange={(e) => setValorContra(e.target.value)}
                    className="rounded-[8px] border border-line bg-surface px-2.5 py-1.5 text-sm"
                  />
                  <div className="flex gap-2">
                    <Button
                      disabled={ocupado || centavosDoTexto(valorContra) === null}
                      onClick={() => decidir('contrapor')}
                    >
                      Enviar ao lead
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setContrapondo(false)}
                      disabled={ocupado}
                    >
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={ocupado} onClick={() => decidir('aprovar')}>
                    Aprovar {reaisDeCentavos(p.valorPedidoCentavos ?? 0)}
                  </Button>
                  <Button variant="ghost" disabled={ocupado} onClick={() => setContrapondo(true)}>
                    Contra-proposta
                  </Button>
                  <Button variant="ghost" disabled={ocupado} onClick={() => setRecusando(true)}>
                    Recusar
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[12px] border border-line bg-surface-2 p-3 text-[13px] text-text-3">
          {pedidoTexto(item)} · sem negociação registrada.
        </div>
      )}

      <ModalMotivo
        aberto={recusando}
        titulo="Recusar o valor pedido"
        descricao="O lead recebe o valor do piso e pode aceitar. O motivo fica no histórico."
        rotuloConfirmar="Recusar"
        aoConfirmar={(motivo) => decidir('recusar', motivo)}
        aoFechar={() => setRecusando(false)}
      />

      <div className="flex flex-col gap-2">
        <Eyebrow>Histórico</Eyebrow>
        {detalhe ? (
          historico.length > 0 ? (
            <LinhaTempo itens={historico} />
          ) : (
            <p className="m-0 text-xs text-text-3">Sem propostas ainda.</p>
          )
        ) : (
          <p className="m-0 text-xs text-text-3">Carregando…</p>
        )}
        {detalhe?.fluxo && (
          <p className="m-0 font-mono text-[10.5px] text-text-3">
            fluxo SDR · etapa {detalhe.fluxo.etapa}
            {detalhe.fluxo.encerramento ? ` · ${detalhe.fluxo.encerramento}` : ''}
          </p>
        )}
      </div>

      {item.conversaId && (
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/inbox?c=${item.conversaId}`}
            className={cn(buttonVariants({ variant: 'outline' }), 'no-underline')}
          >
            Abrir conversa
          </Link>
        </div>
      )}
    </Drawer>
  );
}

function LeadsConteudo() {
  const router = useRouter();
  const params = useSearchParams();
  const instalacao = useInstalacao();
  const { recarregar: recarregarResumo } = useResumo();
  const [leads, setLeads] = useState<LeadView[] | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [erro, setErro] = useState<string | null>(null);
  const l = params.get('l');

  const recarregar = useCallback(() => {
    api
      .leads()
      .then((r) => setLeads(r.leads))
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    recarregar();
    const timer = setInterval(recarregar, 10_000);
    return () => clearInterval(timer);
  }, [recarregar]);

  const todos = leads ?? [];
  const conta = (f: Filtro) =>
    f === 'todos' ? todos.length : todos.filter((x) => grupoDe(x) === f).length;
  const lista = useMemo(
    () => (filtro === 'todos' ? todos : todos.filter((x) => grupoDe(x) === filtro)),
    [todos, filtro],
  );
  const item = l ? (todos.find((x) => x.id === l) ?? null) : null;
  const fechar = useCallback(() => router.replace('/leads'), [router]);
  // 015b: a decisão muda o lead E o badge da barra superior
  const aoMudar = useCallback(
    (msg: string | null) => {
      setErro(msg);
      recarregar();
      recarregarResumo();
    },
    [recarregar, recarregarResumo],
  );

  return (
    <div
      className={cn('grid h-full overflow-hidden', item && 'xl:grid-cols-[minmax(0,1fr)_400px]')}
    >
      <Pagina className="min-w-0">
        <PageHeader
          eyebrow={`${instalacao?.nome ?? 'Leads'} · vendas`}
          titulo="Leads"
          acoes={
            <Filtros<Filtro>
              itens={[
                { id: 'todos', rotulo: 'Todos', n: conta('todos') },
                { id: 'aprovacao', rotulo: 'Aguardando aprovação', n: conta('aprovacao') },
                { id: 'qualificando', rotulo: 'Qualificando', n: conta('qualificando') },
                { id: 'proposta', rotulo: 'Com proposta', n: conta('proposta') },
                { id: 'agendados', rotulo: 'Agendados', n: conta('agendados') },
                { id: 'perdidos', rotulo: 'Perdidos', n: conta('perdidos') },
              ]}
              ativo={filtro}
              aoMudar={setFiltro}
            />
          }
        />
        {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
        {leads && todos.length === 0 ? (
          <Vazio
            titulo="Nenhum lead ainda"
            texto="Um lead nasce quando um número sem vínculo pergunta preço no WhatsApp: o SDR qualifica (pessoas, períodos), mostra o estoque e registra a proposta."
          />
        ) : (
          <Tabela
            colunas={COLUNAS}
            cabecalho={['Telefone', 'Status', 'Cota', 'Última', 'Perfil', 'Pedido / observação']}
          >
            {lista.map((x) => {
              const estado = estadoLead(x.status, x.proposta);
              return (
                <Linha
                  key={x.id}
                  colunas={COLUNAS}
                  ativa={x.id === l}
                  onClick={() => router.replace(`/leads?l=${x.id}`)}
                >
                  <span className="font-mono text-xs">{x.nome ?? telefoneMascarado(x.waId)}</span>
                  <span>
                    <Chip papel={estado.papel} tamanho="md">
                      {estado.rotulo}
                    </Chip>
                  </span>
                  <span className="font-mono text-xs text-text-2">
                    {x.proposta?.cotaCodigo ?? '—'}
                  </span>
                  <span className="text-[12.5px] text-text-3">{tempoRelativo(x.atualizadoEm)}</span>
                  <span className="text-text-2">{perfilTexto(x.perfil)}</span>
                  <span className="truncate text-text-2">{pedidoTexto(x)}</span>
                </Linha>
              );
            })}
            {leads && lista.length === 0 && (
              <p className="m-0 p-4 text-xs text-text-3">Nenhum lead neste filtro.</p>
            )}
            {!leads && <p className="m-0 p-4 text-xs text-text-3">Carregando…</p>}
          </Tabela>
        )}
      </Pagina>
      {item && (
        <div className="fixed top-14 right-0 bottom-0 z-30 w-[400px] max-w-full shadow-[-12px_0_32px_rgba(20,20,26,.12)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
          <DrawerLead item={item} aoFechar={fechar} aoMudar={aoMudar} />
        </div>
      )}
    </div>
  );
}

export default function LeadsPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <LeadsConteudo />
    </Suspense>
  );
}
