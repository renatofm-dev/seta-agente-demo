import {
  TEXTO_AGENDAMENTO,
  TEXTO_AGUARDANDO_SINAL,
  TEXTO_DADOS,
  TEXTO_JA_NO_PISO,
  TEXTO_NAO_ENTENDI,
  TEXTO_QUALIFICACAO_PERIODOS,
  TEXTO_QUALIFICACAO_PESSOAS,
  TEXTO_SEM_ESTOQUE,
  TEXTO_SEM_INTERESSE,
  textoAgendado,
  textoAlcada,
  textoAprovado,
  textoContraproposta,
  textoLimiteDia,
  textoLista,
  textoOfertaPiso,
  textoOfertaTabela,
  textoRecusadoHumano,
  textoSinalEmitido,
} from './render.js';
import {
  type Acao,
  type Comprador,
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
 *   oferta ──(aceitar)──► dados ──(nome+cpf)──► fechamento  [emitir_sinal]
 *                     └──(cotista: já tem CPF)──► fechamento [emitir_sinal]
 *   fechamento ──(sinal_pago)──► encerrado:vendido  [registrar_venda]
 *   oferta ──(pedir_valor < piso)──► encerrado:aguardando_aprovacao  [escalar_alcada]
 *
 * 045: `agendamento` continua existindo como saída — quem prefere falar com
 * gente diz isso a qualquer momento e o fluxo entrega ao comercial como antes.
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
  comprador: null,
  valorAcordadoCentavos: null,
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
      return aceitar(estado, ctx);
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
        return aceitar(estado, ctx);
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

/**
 * 015b — um humano decidiu a proposta que estava acima da alçada.
 *
 * Aprovar leva ao MESMO destino do aceite (`dados` / `fechamento`, ou
 * `agendamento` com a venda desligada): aprovar um valor e não deixar o lead
 * pagar seria aprovação que não serve para nada. Recusar e contrapropor voltam
 * para `oferta`, com a bola no lead — ele ainda pode aceitar.
 */
function decisaoHumana(estado: EstadoFluxo, acao: Acao, ctx: ContextoFluxo): Transicao {
  if (estado.encerramento !== 'aguardando_aprovacao') {
    // nada a decidir: já foi decidido, ou o fluxo nunca esteve na alçada
    return { estado, mensagens: [], efeito: 'nenhum' };
  }
  const cota = cotaEscolhida(estado);
  const piso = cota ? pisoCentavos(cota.valorTabelaCentavos, ctx.descontoMaxBps) : 0;

  switch (acao.tipo) {
    case 'aprovar_humano': {
      const base: EstadoFluxo = {
        ...estado,
        etapa: 'oferta',
        encerramento: null,
        naoEntendi: 0,
        valorAcordadoCentavos: acao.centavos,
      };
      const seguir = aceitar(base, ctx);
      // a mensagem do aceite é a do humano; o resto da transição é o do fluxo
      return { ...seguir, mensagens: [textoAprovado(acao.centavos), ...seguir.mensagens] };
    }
    case 'contrapropor_humano':
      return {
        estado: {
          ...estado,
          etapa: 'oferta',
          encerramento: null,
          naoEntendi: 0,
          valorAcordadoCentavos: acao.centavos,
        },
        mensagens: [textoContraproposta(acao.centavos)],
        efeito: 'ofertar',
      };
    default:
      // recusado: volta ao piso e a decisão é do lead
      return {
        estado: {
          ...estado,
          etapa: 'oferta',
          encerramento: null,
          naoEntendi: 0,
          oferta: 'piso',
          valorAcordadoCentavos: null,
        },
        mensagens: [textoRecusadoHumano(piso)],
        efeito: 'ofertar',
      };
  }
}

/**
 * 045: o aceite. Na raia do cotista o comprador já é conhecido (nome e CPF do
 * cadastro) e o fluxo salta direto para o sinal — o CPF nunca é pedido nem
 * trafega pela conversa. No lead frio, passa por `dados`.
 */
function aceitar(estado: EstadoFluxo, ctx: ContextoFluxo): Transicao {
  // 045 desligada (nenhum sinal configurado) ⇒ a 015a segue intacta: o aceite
  // entrega o lead ao comercial. É o degrau que mantém as duas versões vivas.
  if (!ctx.sinalCentavos) {
    return {
      estado: { ...estado, etapa: 'agendamento', naoEntendi: 0 },
      mensagens: [TEXTO_AGENDAMENTO],
      efeito: 'nenhum',
    };
  }
  const conhecido = ctx.compradorConhecido ?? null;
  if (conhecido) return irParaFechamento({ ...estado, comprador: conhecido }, ctx);
  return {
    estado: { ...estado, etapa: 'dados', naoEntendi: 0 },
    mensagens: [TEXTO_DADOS],
    efeito: 'nenhum',
  };
}

/** Sinal emitido: a mensagem sai, o server emite a cobrança e manda o card do PIX. */
function irParaFechamento(estado: EstadoFluxo, ctx: ContextoFluxo): Transicao {
  const cota = cotaEscolhida(estado);
  const total = valorOfertadoCentavos(estado, ctx.descontoMaxBps) ?? cota?.valorTabelaCentavos ?? 0;
  const sinal = Math.min(ctx.sinalCentavos ?? 0, total);
  return {
    estado: { ...estado, etapa: 'fechamento', naoEntendi: 0 },
    mensagens: [textoSinalEmitido(sinal, total)],
    efeito: 'emitir_sinal',
  };
}

export function transicionar(estado: EstadoFluxo, acao: Acao, ctx: ContextoFluxo): Transicao {
  /**
   * 015b: as decisões do console vêm ANTES do guard de fluxo encerrado — é
   * justamente de `encerrado:aguardando_aprovacao` que elas partem. Só saem
   * daí: aplicar uma aprovação a um fluxo em qualquer outro estado seria
   * reabrir uma conversa que já seguiu adiante.
   */
  if (
    acao.tipo === 'aprovar_humano' ||
    acao.tipo === 'recusar_humano' ||
    acao.tipo === 'contrapropor_humano'
  ) {
    return decisaoHumana(estado, acao, ctx);
  }
  if (estado.etapa === 'encerrado') return { estado, mensagens: [], efeito: 'nenhum' };
  if (acao.tipo === 'cancelar') {
    return {
      estado: encerrar(estado, 'sem_interesse'),
      mensagens: [TEXTO_SEM_INTERESSE],
      efeito: 'nenhum',
    };
  }
  /**
   * 045: `fechamento` intercepta ANTES do guard de `nao_entendi`, e isso é a
   * correção de um defeito real: o guard global roda antes do switch por etapa,
   * então tudo que o comprador dissesse enquanto o PIX não caía contava como
   * "não entendi" — duas mensagens e o fluxo saía da frente, **abandonando uma
   * cobrança já emitida**. Aqui nada que ele diga derruba o fluxo; quem o faz
   * avançar é o webhook do PSP.
   */
  if (estado.etapa === 'fechamento' && acao.tipo !== 'sinal_pago' && acao.tipo !== 'agendar') {
    /**
     * 046: além de dizer que o pagamento não caiu, REENVIA o PIX. Quem escreve
     * aqui quase sempre está perguntando por ele — e em campo o silêncio custou
     * caro: o comprador ouviu "estou te mandando o PIX" e ficou esperando. O
     * reenvio é dedupado pela chave do outbox, então não vira enxurrada.
     */
    return { estado, mensagens: [TEXTO_AGUARDANDO_SINAL], efeito: 'reenviar_sinal' };
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
    case 'dados': {
      // "prefiro falar com alguém" continua valendo aqui
      if (acao.tipo === 'agendar') {
        return {
          estado: { ...estado, etapa: 'agendamento', naoEntendi: 0 },
          mensagens: [TEXTO_AGENDAMENTO],
          efeito: 'nenhum',
        };
      }
      if (acao.tipo !== 'dados') return naoEntendi(estado);
      const comprador: Comprador = { nome: acao.nome, cpf: acao.cpf };
      return irParaFechamento({ ...estado, comprador }, ctx);
    }
    case 'fechamento': {
      // só duas ações chegam aqui (o guard acima filtra o resto)
      if (acao.tipo === 'agendar') {
        return {
          estado: { ...estado, etapa: 'agendamento', naoEntendi: 0 },
          mensagens: [TEXTO_AGENDAMENTO],
          efeito: 'nenhum',
        };
      }
      // o aviso do PSP: o único caminho para a venda existir
      return { estado: encerrar(estado, 'vendido'), mensagens: [], efeito: 'registrar_venda' };
    }
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
