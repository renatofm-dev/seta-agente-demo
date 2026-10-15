'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kpi, Vazio } from '@/components/ui/card';
import { Chip, type Papel } from '@/components/ui/chip';
import { Campo, Select } from '@/components/ui/input';
import { PageHeader, Pagina } from '@/components/ui/page-header';
import { Linha, Tabela } from '@/components/ui/tabela';
import { type AlvoCarteira, api, type CarteiraInadimplente } from '@/lib/console-api';
import { dataCurta, nomeExibicao, reaisDeCentavos, telefoneBonito } from '@/lib/formatos';
import { useInstalacao } from '../layout';

/**
 * Carteira (044): quem está em atraso e seria cobrado pela campanha.
 *
 * A tela tem DOIS estados e eles não se parecem de propósito: olhar a carteira
 * é inócuo, disparar cobrança fala com gente de verdade. Por isso o botão de
 * disparo abre uma confirmação que repete o número de pessoas e o total — e por
 * isso o padrão da rota é dry-run, não o contrário.
 *
 * O que a tabela mostra por linha é o que a campanha FARIA: a parcela mais
 * antiga vencida daquele contrato, com valor e vencimento. Mostrar o saldo
 * vencido total sem mostrar a parcela cobrada confundiria os dois números.
 */

const COLUNAS = '1.5fr 1fr .7fr 1fr .8fr 1.2fr 1fr';

const RECUSA: Record<NonNullable<AlvoCarteira['recusa']>, { rotulo: string; papel: Papel }> = {
  suprimido: { rotulo: 'Pediu para sair', papel: 'off' },
  acima_do_teto: { rotulo: 'Acima da alçada', papel: 'warn' },
  cobranca_em_aberto: { rotulo: 'Já tem cobrança', papel: 'info' },
  // dois contatos no mesmo contrato: a cobrança é da parcela, não do contato
  contrato_repetido: { rotulo: 'Outro contato do contrato', papel: 'off' },
};

function ModalConfirmar({
  cobraveis,
  totalCentavos,
  ocupado,
  aoConfirmar,
  aoFechar,
}: {
  cobraveis: number;
  totalCentavos: number;
  ocupado: boolean;
  aoConfirmar: () => void;
  aoFechar: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold">Disparar cobrança para {cobraveis} cotista(s)?</h2>
        <p className="mt-2 text-sm text-text-2">
          Vai emitir <strong>{cobraveis}</strong> cobrança(s) no gateway, somando{' '}
          <strong>{reaisDeCentavos(totalCentavos)}</strong>, e enviar a mensagem no WhatsApp de cada
          um. Quem aparece recusado na lista não recebe nada.
        </p>
        <p className="mt-2 text-sm text-text-3">
          Isto abre conversa com pessoas reais e não tem desfazer.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={aoFechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button onClick={aoConfirmar} disabled={ocupado}>
            {ocupado ? 'Disparando…' : 'Confirmar e disparar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function CarteiraPage() {
  const instalacao = useInstalacao();
  const [atrasoMinimoDias, setAtraso] = useState(1);
  const [saldoMinimoCentavos, setSaldo] = useState(0);
  const [dados, setDados] = useState<CarteiraInadimplente | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setDados(await api.carteiraInadimplente({ atrasoMinimoDias, saldoMinimoCentavos }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'não foi possível ler a carteira');
    }
  }, [atrasoMinimoDias, saldoMinimoCentavos]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const cobraveis = (dados?.linhas ?? []).filter((l) => l.recusa === null);
  const totalCobravel = cobraveis.reduce((s, l) => s + l.parcelaValorCentavos, 0);
  const saldoTotal = (dados?.linhas ?? []).reduce((s, l) => s + l.saldoVencidoCentavos, 0);

  async function disparar() {
    setOcupado(true);
    try {
      const r = await api.dispararCampanhaCobranca({ atrasoMinimoDias, saldoMinimoCentavos });
      setAviso(
        `${r.cobrancasCriadas} cobrança(s) criada(s). ${r.recusados.length} recusada(s) — veja o motivo na lista.`,
      );
      setConfirmando(false);
      await carregar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'o disparo falhou');
    } finally {
      setOcupado(false);
    }
  }

  // `instalacao` é null até o layout carregar; só esconde a tela quando a
  // resposta chegou E disse que o módulo está desligado
  if (instalacao && !instalacao.modulos.pagamentos) {
    return (
      <Pagina>
        <PageHeader titulo="Carteira" />
        <Vazio texto="O módulo de pagamentos está desligado nesta instalação." />
      </Pagina>
    );
  }

  return (
    <Pagina>
      <PageHeader
        eyebrow="Cobrança ativa"
        titulo="Carteira inadimplente"
        subtitulo="Quem está em atraso e o que a campanha cobraria de cada um — a parcela mais antiga vencida."
        acoes={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => void carregar()}>
              Atualizar
            </Button>
            <Button onClick={() => setConfirmando(true)} disabled={cobraveis.length === 0}>
              Disparar cobrança
            </Button>
          </div>
        }
      />

      {aviso && (
        <div className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
          {aviso}
        </div>
      )}
      {erro && (
        <div className="mb-4 rounded-lg border border-warn-2/35 bg-warn-2/10 px-3 py-2 text-sm text-warn">
          {erro}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi rotulo="Inadimplentes na carteira" valor={dados?.total ?? '—'} />
        <Kpi rotulo="Cobráveis agora" valor={cobraveis.length} tom="ok" />
        <Kpi
          rotulo="A cobrar nesta campanha"
          valor={reaisDeCentavos(totalCobravel)}
          nota="uma parcela por pessoa"
        />
        <Kpi
          rotulo="Saldo vencido total"
          valor={reaisDeCentavos(saldoTotal)}
          nota="dívida inteira, não o que será cobrado"
          tom="risk"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo rotulo="Atraso mínimo">
          <Select
            value={String(atrasoMinimoDias)}
            onChange={(e) => setAtraso(Number(e.target.value))}
          >
            <option value="1">qualquer vencida</option>
            <option value="15">15 dias ou mais</option>
            <option value="30">30 dias ou mais</option>
            <option value="60">60 dias ou mais</option>
            <option value="90">90 dias ou mais</option>
          </Select>
        </Campo>
        <Campo rotulo="Saldo vencido mínimo">
          <Select
            value={String(saldoMinimoCentavos)}
            onChange={(e) => setSaldo(Number(e.target.value))}
          >
            <option value="0">qualquer valor</option>
            <option value="100000">R$ 1.000 ou mais</option>
            <option value="500000">R$ 5.000 ou mais</option>
            <option value="1000000">R$ 10.000 ou mais</option>
          </Select>
        </Campo>
        {dados?.truncadoEm != null && (
          <Chip papel="warn">
            lista cortada em {dados.truncadoEm} — o teto por campanha é {dados.maxPorCampanha}
          </Chip>
        )}
      </div>

      {dados && dados.linhas.length === 0 ? (
        <Vazio
          titulo="Ninguém em atraso neste filtro"
          texto="Afrouxe o atraso mínimo ou o saldo mínimo para ver mais contratos."
        />
      ) : (
        <Tabela
          colunas={COLUNAS}
          minWidth={900}
          cabecalho={[
            'Cotista',
            'Contrato',
            'Vencidas',
            'Saldo vencido',
            'Atraso',
            'Parcela a cobrar',
            'Situação',
          ]}
        >
          {(dados?.linhas ?? []).map((l) => (
            <Linha key={l.waId} colunas={COLUNAS}>
              <span className="min-w-0">
                <span className="block truncate font-semibold">{nomeExibicao(l.nome, l.waId)}</span>
                <span className="block truncate text-[11.5px] text-text-3">
                  {telefoneBonito(l.waId)}
                </span>
              </span>
              <span className="text-text-2">nº {l.contratoId}</span>
              <span className="text-text-2">{l.qtdVencidas}</span>
              <span className="text-text-2">{reaisDeCentavos(l.saldoVencidoCentavos)}</span>
              <span
                className={l.maiorAtrasoDias >= 60 ? 'font-semibold text-brand' : 'text-text-2'}
              >
                {l.maiorAtrasoDias} dias
              </span>
              <span className="min-w-0">
                <span className="block truncate">
                  {l.parcela} — {reaisDeCentavos(l.parcelaValorCentavos)}
                </span>
                <span className="block truncate text-[11.5px] text-text-3">
                  venceu em {dataCurta(l.parcelaVencimento)}
                </span>
              </span>
              <span>
                {l.recusa ? (
                  <Chip papel={RECUSA[l.recusa].papel}>{RECUSA[l.recusa].rotulo}</Chip>
                ) : (
                  <Chip papel="ok">Cobrável</Chip>
                )}
              </span>
            </Linha>
          ))}
        </Tabela>
      )}

      {confirmando && (
        <ModalConfirmar
          cobraveis={cobraveis.length}
          totalCentavos={totalCobravel}
          ocupado={ocupado}
          aoConfirmar={() => void disparar()}
          aoFechar={() => setConfirmando(false)}
        />
      )}
    </Pagina>
  );
}
