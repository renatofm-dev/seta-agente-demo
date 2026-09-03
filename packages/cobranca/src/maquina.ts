import {
  TEXTO_CANCELADO,
  TEXTO_EM_DIA,
  TEXTO_METODO,
  TEXTO_NAO_ENTENDI,
  TEXTO_SEM_DOCUMENTO,
  textoBloqueado,
  textoConfirmacao,
  textoGerando,
  textoLimiteDia,
  textoLista,
  textoTeto,
  textoUnica,
} from './render.js';
import {
  type Acao,
  type Candidato,
  type ContextoFluxo,
  type EstadoFluxo,
  opcoesDe,
  type Transicao,
  totalSelecionado,
  vencidasDe,
} from './tipos.js';

/**
 * Máquina de estados do fluxo de cobrança. Pura e síncrona: recebe estado +
 * ação e devolve o novo estado, as mensagens e o efeito que o server executa.
 * Nada aqui emite cobrança — só decide.
 */

/** Duas respostas seguidas não entendidas ⇒ o fluxo sai da frente do agente geral. */
export const MAX_NAO_ENTENDI = 2;

function encerrado(
  base: Omit<EstadoFluxo, 'etapa' | 'encerramento'>,
  encerramento: EstadoFluxo['encerramento'],
): EstadoFluxo {
  return { ...base, etapa: 'encerrado', encerramento };
}

function ordenar(candidatos: readonly Candidato[]): Candidato[] {
  const peso = (c: Candidato) => (c.situacao === 'vencida' ? 0 : 1);
  return [...candidatos].sort(
    (a, b) => peso(a) - peso(b) || a.vencimento.localeCompare(b.vencimento),
  );
}

export function iniciar(candidatosBrutos: readonly Candidato[], ctx: ContextoFluxo): Transicao {
  const candidatos = ordenar(candidatosBrutos);
  const base: Omit<EstadoFluxo, 'etapa' | 'encerramento'> = {
    candidatos,
    selecao: [],
    metodo: null,
    naoEntendi: 0,
  };

  if (ctx.contratoStatus === 'cancelado') {
    return {
      estado: encerrado(base, 'bloqueado'),
      mensagens: [textoBloqueado('cancelado')],
      efeito: 'escalar_bloqueio',
    };
  }
  if (ctx.distratoEmAnalise) {
    return {
      estado: encerrado(base, 'bloqueado'),
      mensagens: [textoBloqueado('distrato')],
      efeito: 'escalar_bloqueio',
    };
  }
  if (!ctx.temDocumento) {
    return {
      estado: encerrado(base, 'sem_documento'),
      mensagens: [TEXTO_SEM_DOCUMENTO],
      efeito: 'escalar_bloqueio',
    };
  }
  if (ctx.cobrancasHoje >= ctx.maxPorDia) {
    return {
      estado: encerrado(base, 'limite_dia'),
      mensagens: [textoLimiteDia(ctx.cobrancasHoje)],
      efeito: 'escalar_bloqueio',
    };
  }
  if (candidatos.length === 0) {
    return {
      estado: encerrado(base, 'sem_pendencia'),
      mensagens: [TEXTO_EM_DIA],
      efeito: 'nenhum',
    };
  }
  const unico = candidatos[0];
  if (candidatos.length === 1 && unico) {
    return {
      estado: { ...base, etapa: 'metodo', selecao: [unico.tituloId], encerramento: null },
      mensagens: [`${textoUnica(unico)}\n\n${TEXTO_METODO}`],
      efeito: 'nenhum',
    };
  }
  return {
    estado: { ...base, etapa: 'selecao', encerramento: null },
    mensagens: [textoLista({ candidatos })],
    efeito: 'nenhum',
  };
}

function naoEntendi(estado: EstadoFluxo): Transicao {
  const vezes = estado.naoEntendi + 1;
  if (vezes >= MAX_NAO_ENTENDI) {
    return {
      estado: { ...estado, naoEntendi: vezes, etapa: 'encerrado', encerramento: 'abandonado' },
      mensagens: [], // o agente geral responde este turno
      efeito: 'nenhum',
    };
  }
  return {
    estado: { ...estado, naoEntendi: vezes },
    mensagens: [TEXTO_NAO_ENTENDI],
    efeito: 'nenhum',
  };
}

export function transicionar(estado: EstadoFluxo, acao: Acao, ctx: ContextoFluxo): Transicao {
  if (estado.etapa === 'encerrado') {
    return { estado, mensagens: [], efeito: 'nenhum' };
  }
  if (acao.tipo === 'cancelar') {
    return {
      estado: { ...estado, etapa: 'encerrado', encerramento: 'cancelado' },
      mensagens: [TEXTO_CANCELADO],
      efeito: 'nenhum',
    };
  }
  if (acao.tipo === 'nao_entendi') return naoEntendi(estado);

  switch (estado.etapa) {
    case 'selecao': {
      if (acao.tipo === 'todas') {
        const ids = vencidasDe(estado).map((c) => c.tituloId);
        if (ids.length === 0) return naoEntendi(estado);
        return {
          estado: { ...estado, etapa: 'metodo', selecao: ids, naoEntendi: 0 },
          mensagens: [TEXTO_METODO],
          efeito: 'nenhum',
        };
      }
      if (acao.tipo === 'escolher') {
        const opcao = opcoesDe(estado)[acao.indice - 1];
        if (!opcao) return naoEntendi(estado);
        const ids =
          opcao.tipo === 'titulo'
            ? [opcao.candidato.tituloId]
            : opcao.candidatos.map((c) => c.tituloId);
        return {
          estado: { ...estado, etapa: 'metodo', selecao: ids, naoEntendi: 0 },
          mensagens: [TEXTO_METODO],
          efeito: 'nenhum',
        };
      }
      return naoEntendi(estado);
    }
    case 'metodo': {
      if (acao.tipo !== 'metodo') return naoEntendi(estado);
      const novo: EstadoFluxo = {
        ...estado,
        etapa: 'confirmacao',
        metodo: acao.metodo,
        naoEntendi: 0,
      };
      return { estado: novo, mensagens: [textoConfirmacao(novo)], efeito: 'nenhum' };
    }
    case 'confirmacao': {
      if (acao.tipo === 'metodo') {
        const novo: EstadoFluxo = { ...estado, metodo: acao.metodo, naoEntendi: 0 };
        return { estado: novo, mensagens: [textoConfirmacao(novo)], efeito: 'nenhum' };
      }
      if (acao.tipo !== 'confirmar' || !estado.metodo) return naoEntendi(estado);
      const total = totalSelecionado(estado);
      const fechado: EstadoFluxo = {
        ...estado,
        etapa: 'encerrado',
        encerramento: 'emitindo',
        naoEntendi: 0,
      };
      if (total > ctx.tetoCentavos) {
        return {
          estado: fechado,
          mensagens: [textoTeto(total, estado.metodo)],
          efeito: 'emitir_com_aprovacao',
        };
      }
      return { estado: fechado, mensagens: [textoGerando(estado.metodo)], efeito: 'emitir' };
    }
    default:
      return { estado, mensagens: [], efeito: 'nenhum' };
  }
}
