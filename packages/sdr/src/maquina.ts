import {
  TEXTO_AGENDAMENTO,
  TEXTO_JA_NO_PISO,
  TEXTO_NAO_ENTENDI,
  TEXTO_QUALIFICACAO_PERIODOS,
  TEXTO_QUALIFICACAO_PESSOAS,
  TEXTO_SEM_ESTOQUE,
  TEXTO_SEM_INTERESSE,
  textoAgendado,
  textoAlcada,
  textoLimiteDia,
  textoLista,
  textoOfertaPiso,
  textoOfertaTabela,
} from './render.js';
import {
  type Acao,
  type ContextoFluxo,
  type CotaDisponivel,
  cotaEscolhida,
  type EstadoFluxo,
  MAX_PESSOAS,
  PERIODOS_VALIDOS,
  pisoCentavos,
  selecionarOpcoes,
  type Transicao,
  valorOfertadoCentavos,
} from './tipos.js';

/**
 * Máquina de estados do SDR. Pura e síncrona: recebe estado + ação e devolve o
 * novo estado, as mensagens e o efeito que o server executa. Nada aqui lê
 * estoque nem grava proposta — só decide.
 *
 *   qualificacao ──(pessoas, periodos)──► [buscar_estoque] ──apresentar──► apresentacao
 *   apresentacao ──(escolher)──► oferta@tabela ──(pedir_melhor)──► oferta@piso
 *   oferta ──(aceitar)──► agendamento ──(agendar)──► encerrado:agendado
 *   oferta ──(pedir_valor < piso)──► encerrado:aguardando_aprovacao  [escalar_alcada]
 */

/** Duas respostas seguidas não entendidas ⇒ o fluxo sai da frente do agente geral. */
export const MAX_NAO_ENTENDI = 2;

const ESTADO_INICIAL: EstadoFluxo = {
  etapa: 'qualificacao',
  perfil: { pessoas: null, periodos: null, contato: null },
  opcoes: [],
  escolha: null,
  oferta: null,
  naoEntendi: 0,
  encerramento: null,
};

function encerrar(estado: EstadoFluxo, encerramento: EstadoFluxo['encerramento']): EstadoFluxo {
  return { ...estado, etapa: 'encerrado', encerramento, naoEntendi: 0 };
}

export function iniciar(ctx: ContextoFluxo): Transicao {
  if (ctx.propostasHoje >= ctx.maxPropostasDia) {
    return {
      estado: encerrar(ESTADO_INICIAL, 'limite_dia'),
      mensagens: [textoLimiteDia(ctx.propostasHoje)],
      efeito: 'escalar_limite',
    };
  }
  return { estado: ESTADO_INICIAL, mensagens: [TEXTO_QUALIFICACAO_PESSOAS], efeito: 'nenhum' };
}

/** Depois de `buscar_estoque`: o server leu o catálogo e entrega as cotas. */
export function apresentar(estado: EstadoFluxo, cotas: readonly CotaDisponivel[]): Transicao {
  const opcoes = selecionarOpcoes(cotas, estado.perfil);
  if (opcoes.length === 0) {
    return {
      estado: encerrar({ ...estado, opcoes: [] }, 'sem_estoque'),
      mensagens: [TEXTO_SEM_ESTOQUE],
      efeito: 'escalar_sem_estoque',
    };
  }
  const novo: EstadoFluxo = { ...estado, etapa: 'apresentacao', opcoes, naoEntendi: 0 };
  return { estado: novo, mensagens: [textoLista(novo)], efeito: 'nenhum' };
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

function qualificacao(estado: EstadoFluxo, acao: Acao): Transicao {
  let perfil = estado.perfil;
  if (acao.tipo === 'pessoas') {
    if (acao.n < 1 || acao.n > MAX_PESSOAS) return naoEntendi(estado);
    perfil = { ...perfil, pessoas: acao.n };
  } else if (acao.tipo === 'periodos') {
    if (!PERIODOS_VALIDOS.includes(acao.n)) return naoEntendi(estado);
    perfil = { ...perfil, periodos: acao.n };
  } else {
    return naoEntendi(estado);
  }
  const novo: EstadoFluxo = { ...estado, perfil, naoEntendi: 0 };
  if (perfil.pessoas === null) {
    return { estado: novo, mensagens: [TEXTO_QUALIFICACAO_PESSOAS], efeito: 'nenhum' };
  }
  if (perfil.periodos === null) {
    return { estado: novo, mensagens: [TEXTO_QUALIFICACAO_PERIODOS], efeito: 'nenhum' };
  }
  // qualificado: o server lê o estoque com o perfil e chama `apresentar`
  return { estado: novo, mensagens: [], efeito: 'buscar_estoque' };
}

function oferta(estado: EstadoFluxo, acao: Acao, ctx: ContextoFluxo): Transicao {
  const cota = cotaEscolhida(estado);
  if (!cota) return naoEntendi(estado);
  const piso = pisoCentavos(cota.valorTabelaCentavos, ctx.descontoMaxBps);
  const vigente = valorOfertadoCentavos(estado, ctx.descontoMaxBps) ?? cota.valorTabelaCentavos;

  const irParaPiso = (): Transicao => {
    const novo: EstadoFluxo = { ...estado, oferta: 'piso', naoEntendi: 0 };
    return {
      estado: novo,
      mensagens: [textoOfertaPiso(novo, ctx.descontoMaxBps)],
      efeito: 'ofertar',
    };
  };

  switch (acao.tipo) {
    case 'aceitar':
      return {
        estado: { ...estado, etapa: 'agendamento', naoEntendi: 0 },
        mensagens: [TEXTO_AGENDAMENTO],
        efeito: 'nenhum',
      };
    case 'pedir_melhor':
      if (estado.oferta === 'piso' || piso === vigente) {
        return {
          estado: { ...estado, naoEntendi: 0 },
          mensagens: [TEXTO_JA_NO_PISO],
          efeito: 'nenhum',
        };
      }
      return irParaPiso();
    case 'pedir_valor': {
      if (acao.centavos >= vigente) {
        // pediu igual ou acima do que já está na mesa: é um aceite pelo valor vigente
        return {
          estado: { ...estado, etapa: 'agendamento', naoEntendi: 0 },
          mensagens: [TEXTO_AGENDAMENTO],
          efeito: 'nenhum',
        };
      }
      if (acao.centavos >= piso) {
        // dentro da alçada, mas só ofertamos pontos discretos: vai para o piso
        return irParaPiso();
      }
      return {
        estado: encerrar(estado, 'aguardando_aprovacao'),
        mensagens: [textoAlcada(acao.centavos)],
        efeito: 'escalar_alcada',
        valorPedidoCentavos: acao.centavos,
      };
    }
    default:
      return naoEntendi(estado);
  }
}

export function transicionar(estado: EstadoFluxo, acao: Acao, ctx: ContextoFluxo): Transicao {
  if (estado.etapa === 'encerrado') return { estado, mensagens: [], efeito: 'nenhum' };
  if (acao.tipo === 'cancelar') {
    return {
      estado: encerrar(estado, 'sem_interesse'),
      mensagens: [TEXTO_SEM_INTERESSE],
      efeito: 'nenhum',
    };
  }
  if (acao.tipo === 'nao_entendi') return naoEntendi(estado);

  switch (estado.etapa) {
    case 'qualificacao':
      return qualificacao(estado, acao);
    case 'apresentacao': {
      if (acao.tipo !== 'escolher') return naoEntendi(estado);
      const idx = acao.indice - 1;
      if (!estado.opcoes[idx]) return naoEntendi(estado);
      const novo: EstadoFluxo = {
        ...estado,
        etapa: 'oferta',
        escolha: idx,
        oferta: 'tabela',
        naoEntendi: 0,
      };
      return { estado: novo, mensagens: [textoOfertaTabela(novo)], efeito: 'ofertar' };
    }
    case 'oferta':
      return oferta(estado, acao, ctx);
    case 'agendamento': {
      if (acao.tipo !== 'agendar') return naoEntendi(estado);
      const perfil = { ...estado.perfil, contato: acao.texto };
      const novo = encerrar({ ...estado, perfil }, 'agendado');
      return { estado: novo, mensagens: [textoAgendado(perfil)], efeito: 'agendar' };
    }
    default:
      return { estado, mensagens: [], efeito: 'nenhum' };
  }
}
