'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Kpi, Vazio } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Detalhes, Drawer } from '@/components/ui/drawer';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Filtros, Linha, Tabela } from '@/components/ui/tabela';
import {
  api,
  type StatusVenda,
  type VendaDetalhe,
  type VendasResposta,
  type VendaView,
} from '@/lib/console-api';
import { dataHoraCurta, reaisDeCentavos } from '@/lib/formatos';
import { STATUS_VENDA } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao } from '../layout';

/**
 * Vendas (045): o ciclo comercial do agente, do sinal emitido ao contrato no
 * ERP. Deep-link `?k=<id>`, no mesmo desenho de Reservas e Cobranças.
 *
 * O KPI que importa aqui é **"sinal pago, sem contrato"**: ali o comprador já
 * PAGOU e o contrato ainda não existe no ERP. É a única linha desta tela que
 * representa dinheiro recebido sem contrapartida registrada — e por isso ela é
 * `risk` mesmo com um item só.
 */

type Filtro = 'todas' | 'aguardando' | 'pendentes' | 'registradas' | 'falhas';
const GRUPO: Record<Filtro, readonly StatusVenda[] | null> = {
  todas: null,
  aguardando: ['sinal_emitido'],
  pendentes: ['sinal_pago', 'registrando'],
  registradas: ['registrada'],
  falhas: ['falha', 'cancelada'],
};
const COLUNAS = '1.4fr 1.2fr 1.1fr 1fr 1fr 1fr';

function DrawerVenda({ item, aoFechar }: { item: VendaView; aoFechar: () => void }) {
  const [detalhe, setDetalhe] = useState<VendaDetalhe | null>(null);

  useEffect(() => {
    setDetalhe(null);
    api
      .venda(item.id)
      .then(setDetalhe)
      .catch(() => setDetalhe(null));
  }, [item.id]);

  const s = STATUS_VENDA[item.status];
  const saldo = Math.max(0, item.valorCentavos - item.sinalCentavos);

  return (
    <Drawer
      eyebrow="Venda"
      titulo={item.comprador.nome}
      subtitulo={item.cotaCodigo}
      aoFechar={aoFechar}
    >
      <Chip papel={s.papel} tamanho="md">
        {s.rotulo}
      </Chip>

      <Detalhes
        className="mt-4"
        itens={[
          { rotulo: 'CPF', valor: item.comprador.cpf, mono: true },
          { rotulo: 'Cota', valor: item.cotaCodigo, mono: true },
          { rotulo: 'Valor', valor: reaisDeCentavos(item.valorCentavos) },
          { rotulo: 'Sinal', valor: reaisDeCentavos(item.sinalCentavos) },
          { rotulo: 'Saldo', valor: saldo > 0 ? reaisDeCentavos(saldo) : '—' },
          { rotulo: 'Criada', valor: dataHoraCurta(item.criadoEm) },
        ]}
      />

      {detalhe?.cobranca && (
        <>
          <p className="mt-5 mb-1.5 text-[11px] tracking-wide text-text-3 uppercase">Sinal (PIX)</p>
          <Detalhes
            itens={[
              { rotulo: 'Status', valor: detalhe.cobranca.status },
              { rotulo: 'Valor', valor: reaisDeCentavos(detalhe.cobranca.valorCentavos) },
              {
                rotulo: 'Pago em',
                valor: detalhe.cobranca.pagoEm ? dataHoraCurta(detalhe.cobranca.pagoEm) : '—',
              },
              ...(detalhe.cobranca.urlFatura
                ? [
                    {
                      rotulo: 'Fatura',
                      valor: (
                        <a
                          href={detalhe.cobranca.urlFatura}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          abrir no gateway
                        </a>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      )}

      <p className="mt-5 mb-1.5 text-[11px] tracking-wide text-text-3 uppercase">Escrita no ERP</p>
      <Detalhes
        itens={[
          { rotulo: 'Pessoa', valor: detalhe?.erpPessoaId ?? '—', mono: true },
          { rotulo: 'Casal (lead)', valor: detalhe?.erpCasalId ?? '—', mono: true },
          { rotulo: 'Contrato', valor: item.erpContratoId ?? '—', mono: true },
          { rotulo: 'Estado', valor: detalhe?.escrita?.estado ?? '—' },
          { rotulo: 'Tentativas', valor: detalhe?.escrita?.tentativas ?? '—' },
        ]}
      />
      {(item.motivo ?? detalhe?.escrita?.erro) && (
        <p className="mt-3 rounded-lg bg-risk-bg p-2.5 text-[12.5px] text-risk">
          {item.motivo ?? detalhe?.escrita?.erro}
        </p>
      )}

      <Link
        href={`/inbox?c=${item.conversaId}`}
        className="mt-5 inline-block text-[12.5px] underline"
      >
        Abrir a conversa
      </Link>
    </Drawer>
  );
}

function VendasConteudo() {
  const router = useRouter();
  const params = useSearchParams();
  const instalacao = useInstalacao();
  const [dados, setDados] = useState<VendasResposta | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [aviso, setAviso] = useState<string | null>(null);
  const k = params.get('k');

  const recarregar = useCallback(() => {
    api
      .vendas()
      .then(setDados)
      .catch((err) => setAviso(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    recarregar();
    // o worker muda o status sozinho (sinal_pago → registrando → registrada)
    const timer = setInterval(recarregar, 5_000);
    return () => clearInterval(timer);
  }, [recarregar]);

  const todas = dados?.vendas ?? [];
  const conta = (f: Filtro) =>
    GRUPO[f] === null ? todas.length : todas.filter((v) => GRUPO[f]?.includes(v.status)).length;
  const lista = useMemo(
    () => (GRUPO[filtro] === null ? todas : todas.filter((v) => GRUPO[filtro]?.includes(v.status))),
    [todas, filtro],
  );
  const item = k ? (todas.find((v) => v.id === k) ?? null) : null;
  const fechar = useCallback(() => router.replace('/vendas'), [router]);
  const pagasSemContrato = conta('pendentes');

  return (
    <div
      className={cn('grid h-full overflow-hidden', item && 'xl:grid-cols-[minmax(0,1fr)_400px]')}
    >
      <Pagina className="min-w-0">
        <PageHeader eyebrow={instalacao?.nome ?? 'Vendas'} titulo="Vendas" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            rotulo="Aguardando sinal"
            valor={conta('aguardando')}
            nota={conta('aguardando') > 0 ? 'PIX enviado, sem pagamento' : 'nenhuma'}
          />
          <Kpi
            rotulo="Sinal pago, sem contrato"
            valor={pagasSemContrato}
            tom={pagasSemContrato > 0 ? 'risk' : undefined}
            nota={pagasSemContrato > 0 ? 'dinheiro entrou, ERP pendente' : 'nenhuma'}
          />
          <Kpi rotulo="Contratos criados" valor={conta('registradas')} tom="ok" />
          <Kpi
            rotulo="Falhas"
            valor={conta('falhas')}
            tom={conta('falhas') > 0 ? 'risk' : undefined}
            nota={conta('falhas') > 0 ? 'precisa de ação' : 'nenhuma'}
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
            { id: 'aguardando', rotulo: 'Aguardando sinal', n: conta('aguardando') },
            { id: 'pendentes', rotulo: 'Em registro', n: conta('pendentes') },
            { id: 'registradas', rotulo: 'Registradas', n: conta('registradas') },
            { id: 'falhas', rotulo: 'Falhas', n: conta('falhas') },
          ]}
          ativo={filtro}
          aoMudar={setFiltro}
        />
        {dados && todas.length === 0 ? (
          <Vazio
            titulo="Nenhuma venda ainda"
            texto='Ela nasce quando alguém diz "quero comprar uma cota" no WhatsApp: o agente qualifica, oferta dentro da alçada, manda o PIX do sinal e, com o pagamento, cria o contrato no ERP.'
          />
        ) : (
          <Tabela
            colunas={COLUNAS}
            cabecalho={['Comprador', 'Cota', 'Status', 'Sinal', 'Valor', 'Criada']}
          >
            {lista.map((v) => {
              const s = STATUS_VENDA[v.status];
              return (
                <Linha
                  key={v.id}
                  colunas={COLUNAS}
                  ativa={v.id === k}
                  onClick={() => router.replace(`/vendas?k=${v.id}`)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{v.comprador.nome}</span>
                    <span className="block font-mono text-[11px] text-text-3">
                      {v.erpContratoId ? `contrato ${v.erpContratoId}` : 'sem contrato ainda'}
                    </span>
                  </span>
                  <span className="font-mono text-[11.5px] text-text-2">{v.cotaCodigo}</span>
                  <span>
                    <Chip papel={s.papel} tamanho="md">
                      {s.rotulo}
                    </Chip>
                  </span>
                  <span className="font-heading font-semibold">
                    {reaisDeCentavos(v.sinalCentavos)}
                  </span>
                  <span className="text-text-2">{reaisDeCentavos(v.valorCentavos)}</span>
                  <span className="font-mono text-[11.5px] text-text-2">
                    {dataHoraCurta(v.criadoEm)}
                  </span>
                </Linha>
              );
            })}
            {dados && lista.length === 0 && (
              <p className="m-0 p-4 text-xs text-text-3">Nenhuma venda neste filtro.</p>
            )}
            {!dados && <p className="m-0 p-4 text-xs text-text-3">Carregando…</p>}
          </Tabela>
        )}
      </Pagina>
      {item && (
        <div className="fixed top-14 right-0 bottom-0 z-30 w-[400px] max-w-full shadow-[-12px_0_32px_rgba(20,20,26,.12)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
          <DrawerVenda item={item} aoFechar={fechar} />
        </div>
      )}
    </div>
  );
}

export default function VendasPage() {
  return (
    <Suspense fallback={<main className="p-6 text-sm text-text-3">Carregando…</main>}>
      <VendasConteudo />
    </Suspense>
  );
}
