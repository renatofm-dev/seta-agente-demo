import * as T from './render.js';
import {
  type Acao,
  type ContextoFluxo,
  ESTADO_INICIAL,
  type EstadoFluxo,
  type Etapa,
  faltamHospedes,
  type HospedeReserva,
  type OpcaoReserva,
  type SimulacaoReserva,
  type Transicao,
} from './tipos.js';

/**
 * Máquina do fluxo de reserva (038). Pura, síncrona, sem I/O — molde de
 * `packages/cobranca`.
 *
 * `periodo → hotel → unidade → pagantes → hospedes → confirmacao → encerrado`
 *
 * A ordem tem uma razão que vale registrar: a **simulação acontece em
 * `pagantes`, antes de pedir hóspedes**. Se viesse no fim, o cotista entregaria
 * o CPF de quatro pessoas para ouvir "não tem pontos" ou "esse período está
 * bloqueado" — os dois encerramentos que vêm do ERP acontecem, assim, sem
 * nenhum dado pessoal coletado.
 */

/** Duas incompreensões seguidas e o fluxo sai da frente (molde da cobrança). */
const MAX_NAO_ENTENDI = 2;

const encerrar = (
  estado: EstadoFluxo,
  encerramento: EstadoFluxo['encerramento'],
  mensagens: readonly string[],
  efeito: Transicao['efeito'] = 'nenhum',
): Transicao => ({
  estado: { ...estado, etapa: 'encerrado', encerramento },
  mensagens,
  efeito,
});

const seguir = (
  estado: EstadoFluxo,
  etapa: Etapa,
  mensagens: readonly string[],
  efeito: Transicao['efeito'] = 'nenhum',
  extras: Partial<EstadoFluxo> = {},
): Transicao => ({
  estado: { ...estado, ...extras, etapa, naoEntendi: 0 },
  mensagens,
  efeito,
});

function naoEntendeu(estado: EstadoFluxo): Transicao {
  const n = estado.naoEntendi + 1;
  if (n >= MAX_NAO_ENTENDI) {
    // silêncio de propósito: o agente geral responde este turno
    return encerrar({ ...estado, naoEntendi: n }, 'abandonado', []);
  }
  return {
    estado: { ...estado, naoEntendi: n },
    mensagens: [T.TEXTO_NAO_ENTENDI],
    efeito: 'nenhum',
  };
}

export function iniciar(ctx: ContextoFluxo): Transicao {
  /**
   * Inadimplência NÃO bloqueia reserva: quem decide isso é o TSE (há
   * `PercentualMinimoIntegralizadoExigido` no contrato), e bloquear por conta
   * própria seria inventar regra de negócio nossa. Pergunta registrada no PR.
   */
  if (ctx.contratoStatus !== null && ctx.contratoStatus !== 'ativo') {
    return encerrar(ESTADO_INICIAL, 'bloqueado', [T.TEXTO_BLOQUEADO], 'escalar_bloqueio');
  }
  if (ctx.distratoEmAnalise) {
    return encerrar(ESTADO_INICIAL, 'bloqueado', [T.TEXTO_BLOQUEADO], 'escalar_bloqueio');
  }
  return { estado: ESTADO_INICIAL, mensagens: [T.TEXTO_PERIODO], efeito: 'nenhum' };
}

export function transicionar(estado: EstadoFluxo, acao: Acao, ctx: ContextoFluxo): Transicao {
  if (estado.etapa === 'encerrado') {
    return { estado, mensagens: [], efeito: 'nenhum' };
  }
  if (acao.tipo === 'cancelar') {
    return encerrar(estado, 'cancelado', [T.TEXTO_CANCELADO]);
  }
  if (acao.tipo === 'nao_entendi') return naoEntendeu(estado);

  switch (estado.etapa) {
    case 'periodo':
      if (acao.tipo !== 'periodo') return naoEntendeu(estado);
      // o server busca os hotéis e devolve por `apresentarHoteis`
      return seguir(estado, 'hotel', [], 'buscar_hoteis', {
        checkIn: acao.checkIn,
        checkOut: acao.checkOut,
      });

    case 'hotel': {
      if (acao.tipo !== 'escolher') return naoEntendeu(estado);
      const h = estado.hoteis[acao.indice - 1];
      if (!h) return naoEntendeu(estado);
      return seguir(estado, 'unidade', [], 'buscar_tipos_uh', {
        idHotel: h.id,
        hotel: h.descricao,
      });
    }

    case 'unidade': {
      if (acao.tipo !== 'escolher') return naoEntendeu(estado);
      const t = estado.tiposUh[acao.indice - 1];
      if (!t) return naoEntendeu(estado);
      return seguir(estado, 'pagantes', [T.TEXTO_PAGANTES], 'nenhum', {
        idTipoUh: t.id,
        tipoUh: t.descricao,
      });
    }

    case 'pagantes': {
      if (acao.tipo !== 'pagantes') return naoEntendeu(estado);
      if (acao.adultos + acao.criancas === 0) return naoEntendeu(estado);
      // simula ANTES de pedir CPF: quem não tem pontos ou pegou período
      // bloqueado nunca chega a entregar dado pessoal
      return seguir(estado, 'hospedes', [], 'simular', {
        adultos: acao.adultos,
        criancas: acao.criancas,
      });
    }

    case 'hospedes': {
      if (acao.tipo === 'pronto') {
        if (faltamHospedes(estado) > 0) {
          return { estado, mensagens: [T.textoHospedes(estado)], efeito: 'nenhum' };
        }
        return seguir(estado, 'confirmacao', [T.textoConfirmacao(estado)]);
      }
      if (acao.tipo !== 'hospede') return naoEntendeu(estado);
      const novo: HospedeReserva = {
        nome: acao.nome,
        sobrenome: acao.sobrenome,
        cpf: acao.cpf,
        principal: estado.hospedes.length === 0,
      };
      const hospedes = [...estado.hospedes, novo];
      const pendente = { ...estado, hospedes, naoEntendi: 0 };
      if (faltamHospedes(pendente) > 0) {
        return { estado: pendente, mensagens: [T.textoHospedes(pendente)], efeito: 'nenhum' };
      }
      return seguir(pendente, 'confirmacao', [T.textoConfirmacao(pendente)]);
    }

    case 'confirmacao': {
      if (acao.tipo !== 'confirmar') return naoEntendeu(estado);
      const s = estado.simulacao as SimulacaoReserva;
      if (s.taxaCentavos > ctx.tetoTaxaCentavos) {
        return encerrar(
          estado,
          'aguardando_aprovacao',
          [T.textoAprovacao(s.taxaCentavos)],
          'criar_com_aprovacao',
        );
      }
      return encerrar(estado, 'criando', [T.TEXTO_CRIANDO], 'criar');
    }

    default:
      return naoEntendeu(estado);
  }
}

// --- as funções gêmeas dos efeitos de leitura -------------------------------
// O server executa o efeito e devolve o resultado por aqui. Continuam puras.

export function apresentarHoteis(estado: EstadoFluxo, hoteis: readonly OpcaoReserva[]): Transicao {
  if (hoteis.length === 0) {
    return encerrar(estado, 'sem_hoteis', [T.TEXTO_SEM_HOTEIS], 'escalar_bloqueio');
  }
  const comHoteis = { ...estado, hoteis };
  // um hotel só: não faz sentido perguntar
  if (hoteis.length === 1) {
    const [unico] = hoteis as [OpcaoReserva];
    return seguir(comHoteis, 'unidade', [], 'buscar_tipos_uh', {
      idHotel: unico.id,
      hotel: unico.descricao,
    });
  }
  return seguir(comHoteis, 'hotel', [T.textoHoteis(hoteis)]);
}

export function apresentarTiposUh(estado: EstadoFluxo, tipos: readonly OpcaoReserva[]): Transicao {
  if (tipos.length === 0) {
    return encerrar(estado, 'sem_hoteis', [T.TEXTO_SEM_HOTEIS], 'escalar_bloqueio');
  }
  const comTipos = { ...estado, tiposUh: tipos };
  if (tipos.length === 1) {
    const [unico] = tipos as [OpcaoReserva];
    return seguir(comTipos, 'pagantes', [T.TEXTO_PAGANTES], 'nenhum', {
      idTipoUh: unico.id,
      tipoUh: unico.descricao,
    });
  }
  return seguir(comTipos, 'unidade', [T.textoTiposUh(tipos)]);
}

/**
 * O resultado da simulação. É aqui que nascem os dois "não deu" que a spec
 * exige que venham do ERP — e nenhum deles oferece alternativa inventada.
 */
export function apresentarSimulacao(
  estado: EstadoFluxo,
  simulacao: SimulacaoReserva,
  ctx: ContextoFluxo,
): Transicao {
  if (simulacao.bloqueadas.length > 0) {
    return encerrar(estado, 'periodo_bloqueado', [T.textoPeriodoBloqueado(simulacao.bloqueadas)]);
  }
  if (simulacao.custoPontos > ctx.saldoPontos) {
    return encerrar(estado, 'pontos_insuficientes', [
      T.textoPontosInsuficientes(simulacao.custoPontos, ctx.saldoPontos),
    ]);
  }
  /**
   * O hóspede principal é o TITULAR por padrão, e o CPF dele vem do cadastro do
   * ERP — não do texto e muito menos do modelo. Isso derruba a superfície de
   * risco do CPF para os acompanhantes, e na maioria das reservas para zero.
   */
  const comTitular: readonly HospedeReserva[] =
    ctx.titular.nome.length > 0 && ctx.titular.cpf
      ? [{ nome: ctx.titular.nome, sobrenome: null, cpf: ctx.titular.cpf, principal: true }]
      : [];
  const pendente: EstadoFluxo = {
    ...estado,
    simulacao,
    hospedes: comTitular,
    etapa: 'hospedes',
    naoEntendi: 0,
  };
  const mensagens = [T.textoSimulacao(estado, simulacao)];
  if (faltamHospedes(pendente) === 0) {
    return seguir(pendente, 'confirmacao', [...mensagens, T.textoConfirmacao(pendente)]);
  }
  return {
    estado: pendente,
    mensagens: [...mensagens, T.textoHospedes(pendente)],
    efeito: 'nenhum',
  };
}
