import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ErpBusinessError } from './erros.js';
import { criarHttp, type TseHttpConfig } from './http.js';
import {
  CriarUtilizacaoInputSchema,
  MinhasUtilizacoesSchema,
  OpcaoHotelSchema,
  OpcaoTipoUhSchema,
  paraSimulacao,
  paraUtilizacao,
  paraUtilizacaoListada,
  SimularUtilizacaoInputSchema,
  type UtilizacaoErp,
} from './reserva.js';
import {
  type ApiConnector,
  centavosParaReais,
  type ErpWriter,
  FinanceiroContratoSchema,
  type ParcelaErp,
  paraParcelaErp,
  RegistrarPagamentoInputSchema,
} from './tipos.js';
import {
  type CasalErp,
  contratoDaProsa,
  LeadInputSchema,
  mesmoCasal,
  PessoaInputSchema,
  paraCasal,
  paraReais,
  pessoaDaResposta,
  VendaInputSchema,
} from './venda.js';

/**
 * Cliente do TS Explorer (036). Duas operações, e a segunda existe por causa da
 * primeira: registrar a baixa, e reler a parcela para saber se a baixa pegou.
 */

/**
 * `"Transação inserida com sucesso, sob id: 1"` — string, não objeto. A extração
 * é por regex ESTRITA: HTTP 200 não é prova de sucesso nesta API, e qualquer
 * prosa que não case vira erro de negócio, nunca sucesso silencioso.
 */
const ID_DA_PROSA = /sob id:\s*(\d+)/i;

/** Mesma regra para as prosas da reserva: só isto é sucesso. */
const CONFIRMACAO_OK = /confirmad[ao]\s+com\s+sucesso/i;
const CANCELAMENTO_OK = /cancelad[ao]\s+com\s+sucesso/i;

/**
 * Limite de `CodigoAutorizacao` NÃO CONFIRMADO pelo fornecedor (no exemplo da
 * coleção tem 6 caracteres; a coluna do simulador é varchar(40)). Enquanto a
 * resposta não vem, 40 é o teto e o id do PSP passa inteiro — `pay_…` do Asaas
 * tem 18. Se algum dia estourar, vira hash curto determinístico e a
 * correspondência fica em `erp_escrita.payload`, que é quem o financeiro lê.
 */
export const CODIGO_AUTORIZACAO_MAX = 40;

export function codigoAutorizacao(referencia: string, max = CODIGO_AUTORIZACAO_MAX): string {
  if (referencia.length <= max) return referencia;
  return createHash('sha256').update(referencia).digest('hex').slice(0, max);
}

/** Teto de páginas no read-back: contrato da demo tem 110 parcelas (11 páginas). */
const MAX_PAGINAS = 50;

/** `%PDF` — o cabeçalho que separa um boleto de uma página de erro com 200. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

export interface TseErpApi extends ErpWriter {
  /** Exposto para a 037 plugar o catálogo; a 036 não usa de fora. */
  readonly api: ApiConnector;
}

export function createTseErpApi(config: TseHttpConfig): TseErpApi {
  const { api, baixar } = criarHttp(config);

  /**
   * 045: função LOCAL, não método — `criarLead` a chama duas vezes (antes e
   * depois de gravar) e `this` num objeto literal se perde assim que alguém
   * desestrutura o writer.
   */
  const listarLeads = async (de: string, ate: string): Promise<CasalErp[]> => {
    const { json } = await api.request({
      method: 'GET',
      path:
        '/api/recepcaots/GetCasaisPorPeriodo' +
        `?dataInicial=${de}&dataFinal=${ate}&idUnidadeNegocio=1&somenteAgendados=false`,
    });
    return (Array.isArray(json) ? json : []).map(paraCasal);
  };

  return {
    fornecedor: 'tse',
    api,

    async registrarPagamento(entrada) {
      const i = RegistrarPagamentoInputSchema.parse(entrada);
      /**
       * PREMISSA (registrada no PR da 036, pergunta aberta ao fornecedor):
       * `TransacaoEletronica` é o ÚNICO endpoint de baixa da coleção e o corpo
       * dele é de cartão. Varremos os 90 requests: não há campo de
       * `DataPagamento`/`DataRecebimento`/liquidação em lugar nenhum.
       *
       * Como a plataforma cobra por PIX e boleto (042/043), mandamos os campos
       * de cartão NULOS e o id da cobrança no PSP em `CodigoAutorizacao` — que
       * dá ao financeiro do cliente o link com o extrato do gateway e é o que
       * o read-back usa para reconhecer a própria baixa.
       *
       * Não inventamos endpoint nem campo: só o que a coleção tem. Se a resposta
       * do fornecedor for outra, muda ESTA função e mais nada.
       */
      const { json } = await api.request({
        method: 'POST',
        path: '/api/financeiro/TransacaoEletronica',
        body: {
          IdContaFinanceira: Number(i.contaFinanceiraId),
          Valor: centavosParaReais(i.valorCentavos),
          QuatroPrimeirosDigitosCartao: i.quatroPrimeiros ?? null,
          QuatroUltimosDigitosCartao: i.quatroUltimos ?? null,
          CodigoAutorizacao: codigoAutorizacao(i.referenciaPsp),
          QuantidadeParcelas: i.parcelas,
          NomePessoa: i.pagadorNome ?? null,
        },
      });
      const prosa = typeof json === 'string' ? json : JSON.stringify(json);
      const casou = ID_DA_PROSA.exec(prosa);
      if (!casou?.[1]) {
        throw new ErpBusinessError(
          `TSE respondeu 200 sem id de transação: ${prosa.slice(0, 200)}`,
          200,
          prosa,
        );
      }
      return { transacaoId: casou[1] };
    },

    // --- 038: reserva --------------------------------------------------------

    async listarHoteis(contratoId) {
      const { json } = await api.request({
        method: 'GET',
        path: `/api/utilizacaocontrato/ObterHoteis/${contratoId}`,
      });
      return z
        .array(OpcaoHotelSchema)
        .parse(json)
        .map((h) => ({ id: h.IdHotelNegocio, descricao: h.Descricao }));
    },

    async listarTiposUh(idHotel) {
      const { json } = await api.request({
        method: 'GET',
        path: `/api/utilizacaocontrato/ObterTiposUnidadeHoteleira/${idHotel}`,
      });
      return z
        .array(OpcaoTipoUhSchema)
        .parse(json)
        .map((t) => ({ id: t.IdTipoUnidadeHoteleira, descricao: t.Descricao }));
    },

    /**
     * DIVERGÊNCIA: a coleção salvou esta rota como **GET com body**, e o `fetch`
     * do Node recusa body em GET. Vai como GET + query string, que é como o
     * simulador da 035 a expõe. Se o TSE real exigir o body, o ponto de troca é
     * o `fetchFn` injetável — nenhum chamador muda.
     */
    async simularUtilizacao(entrada) {
      const i = SimularUtilizacaoInputSchema.parse(entrada);
      const { json } = await api.request({
        method: 'GET',
        path: '/api/utilizacaocontrato/SimularUtilizacaoContrato',
        query: {
          IdContrato: i.contratoId,
          IdHotel: i.idHotel,
          IdTipoUh: i.idTipoUh,
          DataInicial: i.checkIn,
          DataFinal: i.checkOut,
          qtdpagantespontos: i.pagantes,
          // a coleção manda estes quatro vazios; `url()` preserva string vazia
          cortesia: '',
          identificadorcortesia: '',
          blockcode: '',
          marketcode: '',
        },
      });
      return paraSimulacao(json);
    },

    async criarUtilizacao(entrada) {
      const i = CriarUtilizacaoInputSchema.parse(entrada);
      const { json } = await api.request({
        method: 'POST',
        path: '/api/utilizacaocontrato/CriarUtilizacaoContrato',
        body: {
          IdContrato: Number(i.contratoId),
          IdHotel: i.idHotel,
          IdTipoUh: i.idTipoUh,
          DataInicial: i.checkIn,
          DataFinal: i.checkOut,
          QtdAdultos: i.adultos,
          QtdCriancas: i.criancas,
          TipoUtilizacao: 'RESERVA',
          // hóspedes INLINE: criar+hóspedes é uma escrita só, e é o que reduz a
          // superfície de não-idempotência de 1+N para 1
          ListaHospedes: i.hospedes.map((h) => ({
            Nome: h.nome,
            Sobrenome: h.sobrenome ?? null,
            Cpf: h.cpf ?? null,
            IdFaixaEtaria: h.faixaEtaria,
            HospedePrincipal: h.principal,
            Sexo: h.sexo ?? null,
          })),
        },
      });
      return paraUtilizacao(json);
    },

    async confirmarUtilizacao(idUtilizacao) {
      const { json } = await api.request({
        method: 'POST',
        path: `/api/utilizacaocontrato/ConfirmarUtilizacaoContrato/${idUtilizacao}`,
      });
      const prosa = typeof json === 'string' ? json : JSON.stringify(json);
      // mesma doutrina da baixa: 200 não é prova de sucesso nesta API
      if (!CONFIRMACAO_OK.test(prosa)) {
        throw new ErpBusinessError(
          `TSE respondeu 200 sem confirmar a utilização: ${prosa.slice(0, 200)}`,
          200,
          prosa,
        );
      }
    },

    async cancelarUtilizacao(idUtilizacao, motivo) {
      const { json } = await api.request({
        method: 'POST',
        path: '/api/utilizacaocontrato/CancelarUtilizacaoContrato',
        body: { IdUtilizacaoContrato: Number(idUtilizacao), MotivoCancelamento: motivo },
      });
      const prosa = typeof json === 'string' ? json : JSON.stringify(json);
      if (!CANCELAMENTO_OK.test(prosa)) {
        throw new ErpBusinessError(
          `TSE respondeu 200 sem cancelar a utilização: ${prosa.slice(0, 200)}`,
          200,
          prosa,
        );
      }
    },

    async lerUtilizacao(idUtilizacao) {
      try {
        const { json } = await api.request({
          method: 'GET',
          path: `/api/utilizacaocontrato/ObterDadosUtilizacaoContrato/${idUtilizacao}`,
        });
        return paraUtilizacao(json);
      } catch (err) {
        // 404 é resposta, não falha: a utilização simplesmente não existe
        if (err instanceof ErpBusinessError && err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Lê pelo PAINEL, que é a única listagem por contrato que a coleção tem.
     * Isso amarra o read-back da reserva à D10 (se o painel resolver escopo pelo
     * dono do token, esta leitura some junto com a financeira) — registrado.
     */
    async listarUtilizacoes(contratoId) {
      const saida: UtilizacaoErp[] = [];
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const { json } = await api.request({
          method: 'GET',
          path: '/api/PainelDoCliente/MinhasUtilizacoesContrato',
          query: { idContrato: contratoId, paginaAtual: pagina },
        });
        const envelope = MinhasUtilizacoesSchema.parse(json);
        saida.push(...envelope.Utilizacoes.map(paraUtilizacaoListada));
        if (pagina >= envelope.TotalPaginas) break;
      }
      return saida;
    },

    async lerSaldoPontos(contratoId) {
      const { json } = await api.request({
        method: 'GET',
        path: '/api/PainelDoCliente/MinhasUtilizacoesContrato',
        query: { idContrato: contratoId, paginaAtual: 1 },
      });
      return MinhasUtilizacoesSchema.parse(json).SaldoPontosGeral;
    },

    /**
     * 040 — a 2ª via em PDF.
     *
     * Duas coisas que o 200 desta rota NÃO prova, e que por isso viram null:
     * um corpo vazio, e um corpo que não é PDF. O ASP.NET responde HTML de erro
     * com 200 em alguns caminhos, e mandar isso ao WhatsApp como se fosse boleto
     * é pior do que dizer que não deu — o cotista abriria um arquivo quebrado
     * sem ninguém ficar sabendo.
     *
     * O 404 é resposta de negócio (não há boleto para a parcela), não falha:
     * `ErpBusinessError` vira `null` aqui; indisponibilidade segue subindo.
     */
    async obterSegundaVia(contaFinanceiraId) {
      const id = z.coerce.number().int().positive().parse(contaFinanceiraId);
      let baixa: Awaited<ReturnType<typeof baixar>>;
      try {
        baixa = await baixar({ path: `/api/PainelDoCliente/SegundaViaBoleto/${id}` });
      } catch (err) {
        if (err instanceof ErpBusinessError) return null;
        throw err;
      }
      if (baixa.bytes.length === 0) return null;
      if (!PDF_MAGIC.every((b, i) => baixa.bytes[i] === b)) return null;
      return { bytes: baixa.bytes, mime: 'application/pdf' };
    },

    async lerParcela(contaFinanceiraId, contratoId) {
      // o painel pagina de 10 em 10 e não filtra por parcela: varre até achar
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const { json } = await api.request({
          method: 'GET',
          path: '/api/PainelDoCliente/FinanceiroContrato',
          query: { idContrato: contratoId, paginaAtual: pagina },
        });
        const envelope = FinanceiroContratoSchema.parse(json);
        const achada = envelope.ListaDados.find(
          (p) => String(p.Identificador) === contaFinanceiraId,
        );
        if (achada) return paraParcelaErp(achada);
        if (pagina >= envelope.TotalPaginas) return null;
      }
      return null;
    },

    // --- 045: ciclo comercial ------------------------------------------------

    async criarPessoa(entrada) {
      const i = PessoaInputSchema.parse(entrada);
      const { json } = await api.request({
        method: 'POST',
        path: '/api/cadastros/SetPessoa/0',
        body: {
          DataCadastro: hoje(),
          IdTipoPessoa: 0,
          RazaoSocial: i.nome,
          NomeFantasia: i.nome,
          CpfCnpj: i.cpf.replace(/\D/g, ''),
        },
      });
      const pessoaId = pessoaDaResposta(json);
      if (pessoaId === null) {
        throw new ErpBusinessError(
          `TSE respondeu 200 sem id de pessoa: ${String(json).slice(0, 200)}`,
          200,
          String(json),
        );
      }
      return { pessoaId };
    },

    listarLeads,

    /**
     * Grava e RELÊ. O POST devolve string vazia (nem id, nem eco), então o
     * único jeito de saber o que foi criado é procurar pelo CPF na janela do
     * dia. A janela é ±1 dia porque o TSE carimba `DataCadastro` no fuso dele
     * e uma escrita perto da meia-noite cairia fora de uma janela de um dia só.
     */
    async criarLead(entrada) {
      const i = LeadInputSchema.parse(entrada);
      const digitos = (i.cpf ?? '').replace(/\D/g, '');
      if (digitos.length === 0) {
        throw new ErpBusinessError('lead sem CPF: o read-back do casal fica impossível', 400, '');
      }
      const [de, ate] = janelaDeLeitura();

      // já gravado numa tentativa anterior cuja resposta se perdeu? adota.
      const antes = await listarLeads(de, ate);
      const existente = antes.find((c: CasalErp) => mesmoCasal(c, digitos));
      if (existente) return { casalId: existente.casalId };

      await api.request({
        method: 'POST',
        path: '/api/recepcaots/setcasal/0',
        body: {
          DataCadastro: hoje(),
          Nome1: i.nome,
          Cpf1: digitos,
          Nome2: '',
          Cpf2: '',
          Email: i.email ?? '',
          TelefoneMovel: i.telefone ?? '',
          IdOrigemCasal: i.idOrigemCasal ?? null,
          Agendado: false,
        },
      });

      const depois = await listarLeads(de, ate);
      const criado = depois.find((c: CasalErp) => mesmoCasal(c, digitos));
      if (!criado) {
        // NÃO grava de novo: sem confirmação, uma segunda escrita é duplicata
        throw new ErpBusinessError(
          'casal gravado mas não encontrado no read-back por CPF',
          200,
          '',
        );
      }
      return { casalId: criado.casalId };
    },

    async criarVenda(entrada) {
      const i = VendaInputSchema.parse(entrada);
      const { json } = await api.request({
        method: 'POST',
        path: '/api/vendats/SetVenda/0',
        body: {
          DataCadastro: hoje(),
          IdCasal: i.idCasal ?? 0,
          IdComprador1: i.idComprador,
          IdComprador2: 0,
          IdProduto: i.idProduto,
          IdCotaUh: i.idCotaUh,
          ValorNegociado: paraReais(i.valorCentavos),
          ValorAVista: paraReais(i.valorCentavos),
          ValorFinanciado: 0,
          ValorDesconto: 0,
          ContabilizadoVenda: true,
          ContasFinanceirasCancel: [],
          ContasFinanceirasAddUpdt: i.parcelas.map((p) => ({
            IdMeioPagamento: p.idMeioPagamento,
            IdTipoOrigemContaFinanceira: p.idTipoOrigem,
            DataVencimento: p.vencimento,
            ValorReceber: paraReais(p.valorCentavos),
            ValorParcela: paraReais(p.valorCentavos),
            QuantidadeParcelas: 1,
            TipoValorInformado: 'INDIVIDUAL',
            DestinoContaFinanceira: 'R',
          })),
        },
      });
      const contratoId = contratoDaProsa(json);
      if (contratoId === null) {
        // 200 com prosa inesperada é erro de negócio — a doutrina da 036
        throw new ErpBusinessError(
          `TSE respondeu 200 sem IdContrato: ${String(json).slice(0, 200)}`,
          200,
          String(json),
        );
      }
      return { contratoId };
    },

    health: () => api.health(),
  } satisfies TseErpApi as TseErpApi;
}

/** Hoje em `YYYY-MM-DD` no fuso do TSE — toda escrita carimba `DataCadastro`. */
function hoje(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/**
 * Janela do read-back do casal: ontem a amanhã. Um único dia falharia para uma
 * escrita perto da virada, já que o carimbo é do fuso do servidor do TSE.
 */
function janelaDeLeitura(): [string, string] {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const dia = 86_400_000;
  const agora = Date.now();
  return [fmt.format(new Date(agora - dia)), fmt.format(new Date(agora + dia))];
}

export type { ParcelaErp };
