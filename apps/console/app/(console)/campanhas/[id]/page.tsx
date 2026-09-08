'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip, Eyebrow } from '@/components/ui/chip';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Filtros, Linha, Tabela } from '@/components/ui/tabela';
import { PreviewWhatsApp } from '@/components/ui/whatsapp';
import { paraCsv, preencherModelo } from '@/lib/campanhas';
import { api, type DisparoDestinatarioView, type DisparoDetalhe } from '@/lib/console-api';
import { dataHoraCurta, nomeExibicao, porcentagem, telefoneMascarado } from '@/lib/formatos';
import { STATUS_DESTINATARIO, STATUS_DISPARO } from '@/lib/rotulos';
import { cn } from '@/lib/utils';

/** Detalhe da campanha (design 5.3.3): funil, mensagem enviada e destinatários. */

type FiltroDest = 'todos' | 'entregues' | 'lidos' | 'falhas' | 'pendentes';
const COLUNAS = '1.4fr 1fr 1.1fr 1fr 1.6fr';

function passa(d: DisparoDestinatarioView, f: FiltroDest): boolean {
  if (f === 'todos') return true;
  if (f === 'entregues') return d.status === 'entregue' || d.status === 'lido';
  if (f === 'lidos') return d.status === 'lido';
  if (f === 'falhas') return d.status === 'falha';
  return d.status === 'pendente';
}

export default function CampanhaDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const [dados, setDados] = useState<DisparoDetalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<FiltroDest>('todos');

  const recarregar = useCallback(() => {
    api
      .disparo(id)
      .then(setDados)
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    recarregar();
    const timer = setInterval(recarregar, 5_000);
    return () => clearInterval(timer);
  }, [recarregar]);

  const dest = dados?.destinatarios ?? [];
  const funil = useMemo(() => {
    const total = dest.length;
    const pendentes = dest.filter((d) => d.status === 'pendente').length;
    const lidas = dest.filter((d) => d.status === 'lido').length;
    const entregues = dest.filter((d) => d.status === 'entregue').length + lidas;
    const falhas = dest.filter((d) => d.status === 'falha').length;
    return [
      { rotulo: 'Destinatários', n: total, cor: 'bg-line-strong' },
      { rotulo: 'Enviadas', n: total - pendentes, cor: 'bg-brand' },
      { rotulo: 'Entregues', n: entregues, cor: 'bg-brand' },
      { rotulo: 'Lidas', n: lidas, cor: 'bg-ok' },
      { rotulo: 'Falhas', n: falhas, cor: 'bg-brand' },
    ];
  }, [dest]);
  const total = dest.length;

  function exportarCsv() {
    if (!dados) return;
    const csv = paraCsv([
      ['cotista', 'telefone', 'status', 'atualizado_em', 'erro'],
      ...dados.destinatarios.map((d) => [
        d.contatoNome ?? '',
        d.waId,
        d.status,
        d.atualizadoEm,
        d.erro ?? '',
      ]),
    ]);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campanha-${dados.modelo.nome}-${dados.disparo.id.slice(-6)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (erro) {
    return (
      <Pagina>
        <PageHeader voltar={{ href: '/campanhas', rotulo: 'Campanhas' }} titulo="Campanha" />
        <p className="m-0 text-sm text-brand">{erro}</p>
      </Pagina>
    );
  }
  if (!dados) {
    return (
      <Pagina>
        <PageHeader voltar={{ href: '/campanhas', rotulo: 'Campanhas' }} titulo="Carregando…" />
      </Pagina>
    );
  }

  const st = STATUS_DISPARO[dados.disparo.status];
  const contagem = (f: FiltroDest) => dest.filter((d) => passa(d, f)).length;

  return (
    <Pagina>
      <PageHeader
        voltar={{ href: '/campanhas', rotulo: 'Campanhas' }}
        titulo={
          <>
            {dados.modelo.nome}
            <Chip papel={st.papel} tamanho="md">
              {st.rotulo}
            </Chip>
          </>
        }
        subtitulo={`${dados.modelo.nome} · ${total} contatos · envio ${dataHoraCurta(dados.disparo.criadoEm)}`}
        acoes={
          <Button variant="outline" size="md" onClick={exportarCsv}>
            Exportar CSV
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
        <Card className="p-5">
          <Eyebrow className="mb-3.5">Funil da campanha</Eyebrow>
          <div className="grid grid-cols-5 gap-2">
            {funil.map((e) => (
              <div key={e.rotulo} className="flex flex-col gap-1.5">
                <div className="flex h-16 items-end">
                  <div
                    className={cn('w-full rounded-[6px_6px_2px_2px]', e.cor)}
                    style={{
                      height: `${total ? Math.max(6, Math.round((e.n / total) * 64)) : 6}px`,
                    }}
                  />
                </div>
                <div className="font-heading text-xl font-semibold tracking-[-.02em]">{e.n}</div>
                <div className="text-xs text-text-2">{e.rotulo}</div>
                <div className="font-mono text-[10.5px] text-text-3">{porcentagem(e.n, total)}</div>
              </div>
            ))}
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          <Eyebrow>Mensagem enviada</Eyebrow>
          <PreviewWhatsApp
            texto={preencherModelo(dados.modelo.corpo, dados.disparo.variaveis)}
            rodape={dados.modelo.rodape}
            hora={dataHoraCurta(dados.disparo.criadoEm).slice(-5)}
          />
        </div>
      </div>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="font-semibold">
            Destinatários{' '}
            <span className="font-mono text-[11px] font-normal text-text-3">{total}</span>
          </div>
          <Filtros<FiltroDest>
            itens={[
              { id: 'todos', rotulo: 'Todos', n: contagem('todos') },
              { id: 'entregues', rotulo: 'Entregues', n: contagem('entregues') },
              { id: 'lidos', rotulo: 'Lidos', n: contagem('lidos') },
              { id: 'falhas', rotulo: 'Falhas', n: contagem('falhas') },
              { id: 'pendentes', rotulo: 'Pendentes', n: contagem('pendentes') },
            ]}
            ativo={filtro}
            aoMudar={setFiltro}
          />
        </div>
        <Tabela
          colunas={COLUNAS}
          cabecalho={['Cotista', 'Telefone', 'Status', 'Atualizado', 'Observação']}
          className="rounded-none border-0"
        >
          {dest
            .filter((d) => passa(d, filtro))
            .map((d) => {
              const s = STATUS_DESTINATARIO[d.status];
              return (
                <Linha key={d.id} colunas={COLUNAS}>
                  <span className="truncate font-semibold">
                    {nomeExibicao(d.contatoNome, d.waId)}
                  </span>
                  <span className="font-mono text-[11.5px] text-text-2">
                    {telefoneMascarado(d.waId)}
                  </span>
                  <span>
                    <Chip papel={s.papel} tamanho="md">
                      {s.rotulo}
                    </Chip>
                  </span>
                  <span className="font-mono text-[11.5px] text-text-2">
                    {dataHoraCurta(d.atualizadoEm)}
                  </span>
                  <span className="truncate text-[12px] text-text-3">{d.erro ?? ''}</span>
                </Linha>
              );
            })}
          {dest.filter((d) => passa(d, filtro)).length === 0 && (
            <p className="m-0 p-4 text-xs text-text-3">Nenhum destinatário neste filtro.</p>
          )}
        </Tabela>
      </Card>
    </Pagina>
  );
}
