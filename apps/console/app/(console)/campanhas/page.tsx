'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Barra, Kpi, Vazio } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Linha, Tabela } from '@/components/ui/tabela';
import { funilDe, resumoDoMes } from '@/lib/campanhas';
import { api, type DisparoResumo } from '@/lib/console-api';
import { dataHoraCurta, porcentagem } from '@/lib/formatos';
import { STATUS_DISPARO } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { useInstalacao } from '../layout';

/**
 * Campanhas (design 5.3 sobre os disparos da 013): lista com KPIs do mês e
 * funil por campanha. Segmentação por faixa de atraso, agendamento, ritmo e
 * aprovação chegam com a campanha segmentada — aqui o público é a carteira.
 */

const COLUNAS = '2fr 1fr 1.3fr 1fr 1.2fr 1.6fr';

export default function CampanhasPage() {
  const router = useRouter();
  const instalacao = useInstalacao();
  const [disparos, setDisparos] = useState<DisparoResumo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const recarregar = useCallback(() => {
    api
      .disparos()
      .then((r) => setDisparos(r.disparos))
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    recarregar();
    const timer = setInterval(recarregar, 5_000); // progresso dos envios
    return () => clearInterval(timer);
  }, [recarregar]);

  const mes = resumoDoMes(disparos ?? []);

  return (
    <Pagina>
      <PageHeader
        eyebrow={instalacao?.nome ?? 'Campanhas'}
        titulo="Campanhas"
        acoes={
          <>
            <Link
              href="/metricas?v=campanhas"
              className={cn(buttonVariants({ size: 'md', variant: 'outline' }), 'no-underline')}
            >
              Relatório
            </Link>
            <Link
              href="/campanhas/nova"
              className={cn(buttonVariants({ size: 'md' }), 'no-underline')}
            >
              + Nova campanha
            </Link>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          rotulo="Enviadas no mês"
          valor={mes.enviadas}
          nota={
            <>
              de {mes.destinatarios} ·{' '}
              <span className="text-ok">{porcentagem(mes.entregues, mes.enviadas)} entregues</span>
            </>
          }
        />
        <Kpi
          rotulo="Taxa de leitura"
          valor={porcentagem(mes.lidas, mes.entregues)}
          nota={`${mes.lidas} lidas no mês`}
        />
        <Kpi
          rotulo="Campanhas ativas"
          valor={mes.ativas}
          nota={`${mes.campanhas} criadas no mês`}
        />
        <Kpi
          rotulo="Falhas de envio"
          valor={mes.falhas}
          tom={mes.falhas > 0 ? 'risk' : undefined}
          nota={mes.falhas > 0 ? 'número fora do WhatsApp ou erro da Meta' : 'nenhuma no mês'}
        />
      </div>
      {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
      {disparos && disparos.length === 0 ? (
        <Vazio
          titulo="Nenhuma campanha ainda"
          texto="Uma campanha é um modelo aprovado na Meta enviado para contatos da carteira. Quem responde cai no atendimento, e o agente segue a conversa."
          acao={
            <Link
              href="/campanhas/nova"
              className={cn(buttonVariants({ size: 'md' }), 'no-underline')}
            >
              + Nova campanha
            </Link>
          }
        />
      ) : (
        <Tabela
          colunas={COLUNAS}
          cabecalho={['Campanha', 'Público', 'Modelo', 'Envio', 'Status', 'Funil']}
        >
          {(disparos ?? []).map((d) => {
            const f = funilDe(d);
            const st = STATUS_DISPARO[d.status];
            return (
              <Linha key={d.id} colunas={COLUNAS} onClick={() => router.push(`/campanhas/${d.id}`)}>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{d.nome ?? d.modelo_nome}</span>
                  {d.variaveis.length > 0 && (
                    <span className="block truncate text-[11.5px] text-text-3">
                      {d.variaveis.join(' · ')}
                    </span>
                  )}
                </span>
                <span className="text-text-2">
                  {d.total} contatos
                  {/* 044: opt-out respeitado aparece na linha. Sem isto, quem criou a
                      campanha vai procurar no funil por que 30 dos 200 não receberam. */}
                  {d.recusados > 0 && (
                    <span className="block text-[11.5px] text-text-3">
                      {d.recusados} não receberam (opt-out)
                    </span>
                  )}
                </span>
                <span className="truncate font-mono text-[11.5px] text-text-2">
                  {d.modelo_nome}
                </span>
                <span className="font-mono text-[11.5px] text-text-2">
                  {dataHoraCurta(d.criado_em)}
                </span>
                <span>
                  <Chip papel={st.papel} tamanho="md">
                    {st.rotulo}
                  </Chip>
                </span>
                <span className="flex items-center gap-2">
                  <Barra fracao={d.total ? f.entregues / d.total : 0} />
                  <span className="whitespace-nowrap font-mono text-[11px] text-text-3">
                    {f.lidas} lidas
                  </span>
                </span>
              </Linha>
            );
          })}
          {!disparos && <p className="m-0 p-4 text-xs text-text-3">Carregando…</p>}
        </Tabela>
      )}
    </Pagina>
  );
}
