'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, Vazio } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Campo, Input, Select, Textarea } from '@/components/ui/input';
import { variaveisDoCorpo } from '@/lib/campanhas';
import { api, type Modelo } from '@/lib/console-api';
import { STATUS_MODELO } from '@/lib/rotulos';

/** Configurações › Canal: modelos de mensagem registrados na Meta (013). */

function FormNovoModelo({ aoCriar, aoCancelar }: { aoCriar: () => void; aoCancelar: () => void }) {
  const [nome, setNome] = useState('');
  const [categoria, setCategoria] = useState<'utility' | 'marketing'>('utility');
  const [corpo, setCorpo] = useState('');
  const [rodape, setRodape] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setSalvando(true);
    try {
      await api.criarModelo({
        nome: nome.trim(),
        categoria,
        corpo: corpo.trim(),
        ...(rodape.trim() ? { rodape: rodape.trim() } : {}),
      });
      aoCriar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <form
      onSubmit={criar}
      className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface-2 p-4"
    >
      <div className="text-[13px] font-semibold">Novo modelo</div>
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <Campo rotulo="Nome (minúsculas e _)">
          <Input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="lembrete_parcela_v2"
            mono
          />
        </Campo>
        <Campo rotulo="Categoria">
          <Select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value as 'utility' | 'marketing')}
          >
            <option value="utility">utility</option>
            <option value="marketing">marketing</option>
          </Select>
        </Campo>
      </div>
      <Campo
        rotulo="Corpo"
        dica={`${variaveisDoCorpo(corpo).length} variável(is) detectada(s) — use {{1}}, {{2}}…`}
      >
        <Textarea
          rows={4}
          value={corpo}
          onChange={(e) => setCorpo(e.target.value)}
          placeholder={'Olá {{1}}, consta em aberto no contrato {{2}}…'}
        />
      </Campo>
      <Campo rotulo="Rodapé (opcional)">
        <Input
          value={rodape}
          onChange={(e) => setRodape(e.target.value)}
          placeholder="Responda SAIR para não receber lembretes"
        />
      </Campo>
      {erro && <p className="m-0 text-xs text-brand">{erro}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="ink" disabled={salvando || !nome.trim() || !corpo.trim()}>
          {salvando ? 'Registrando na Meta…' : 'Criar e enviar para aprovação'}
        </Button>
        <Button type="button" variant="outline" onClick={aoCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function Modelos() {
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [metaConfigurada, setMetaConfigurada] = useState(true);
  const [novo, setNovo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const recarregar = useCallback(() => {
    api
      .modelos()
      .then((r) => {
        setModelos(r.modelos);
        setMetaConfigurada(r.metaConfigurada);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    recarregar();
  }, [recarregar]);

  async function sincronizar() {
    setAviso(null);
    try {
      const r = await api.sincronizarModelos();
      setModelos(r.modelos);
      setAviso(`${r.atualizados} modelo(s) atualizado(s) pela Meta.`);
    } catch (err) {
      setAviso(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-semibold">Modelos de mensagem</div>
        <span className="font-mono text-[11px] text-text-3">{modelos.length}</span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={sincronizar} disabled={!metaConfigurada}>
            Sincronizar com a Meta
          </Button>
          <Button
            variant="ink"
            size="sm"
            onClick={() => setNovo(true)}
            disabled={!metaConfigurada || novo}
          >
            + Novo modelo
          </Button>
        </div>
      </div>
      {!metaConfigurada && (
        <p className="m-0 rounded-[10px] border border-warn-2/35 bg-warn-2/14 px-3 py-2 text-xs text-warn">
          Gestão de modelos indisponível — configure WA_WABA_ID e WA_ACCESS_TOKEN no servidor.
        </p>
      )}
      {aviso && <p className="m-0 text-xs text-text-2">{aviso}</p>}
      {novo && (
        <FormNovoModelo
          aoCriar={() => {
            setNovo(false);
            recarregar();
          }}
          aoCancelar={() => setNovo(false)}
        />
      )}
      {modelos.length === 0 ? (
        <Vazio texto="Nenhum modelo ainda. O modelo é registrado na Meta e só sai em campanha depois de aprovado." />
      ) : (
        modelos.map((m) => {
          const s = STATUS_MODELO[m.statusMeta];
          return (
            <div
              key={m.id}
              className="grid gap-x-3 gap-y-1 border-t border-line-soft py-2.5 text-[13px] sm:grid-cols-[1.2fr_2fr_auto]"
            >
              <span className="font-mono text-xs font-medium">{m.nome}</span>
              <span className="min-w-0">
                <span className="line-clamp-2 whitespace-pre-wrap text-text-2">{m.corpo}</span>
                <span className="block font-mono text-[10.5px] text-text-3">
                  {m.categoria} · {m.idioma} · {variaveisDoCorpo(m.corpo).length} variáveis
                </span>
                {m.motivoRejeicao && (
                  <span className="block text-xs text-brand">Rejeição: {m.motivoRejeicao}</span>
                )}
              </span>
              <Chip papel={s.papel} className="self-start">
                {s.rotulo}
              </Chip>
            </div>
          );
        })
      )}
    </Card>
  );
}
