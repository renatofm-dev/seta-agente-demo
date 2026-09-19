import { ErpBusinessError } from './erros.js';
import {
  CriarUtilizacaoInputSchema,
  type OpcaoErp,
  SimularUtilizacaoInputSchema,
  type UtilizacaoErp,
} from './reserva.js';
import {
  type ErpWriter,
  type ParcelaErp,
  type RegistrarPagamentoInput,
  RegistrarPagamentoInputSchema,
} from './tipos.js';
import {
  type CasalErp,
  LeadInputSchema,
  mesmoCasal,
  PessoaInputSchema,
  type VendaInput,
  VendaInputSchema,
} from './venda.js';

/**
 * `ErpWriter` em memória. Duas utilidades:
 *
 *  - **boot sem TSE**: sem `TSE_BASE_URL` o server sobe com este, e a baixa vira
 *    registro local em vez de exceção no worker — o mesmo desenho do PSP
 *    simulado da 014, e o boot loga qual dos dois está ativo;
 *  - **teste unitário** de quem consome o port, sem rede e sem Postgres.
 */

export interface ErpSimulado extends ErpWriter {
  /** Tudo que foi "gravado", para o teste conferir. */
  readonly transacoes: readonly { input: RegistrarPagamentoInput; transacaoId: string }[];
  /** Semeia uma parcela para o read-back encontrar. */
  semear(p: ParcelaErp): void;
  /** 040: o PDF que `obterSegundaVia` vai devolver para esta parcela. */
  semearBoleto(contaFinanceiraId: string, bytes: Uint8Array): void;
  /** 038: hotéis, tipos de UH e a tarifa que a simulação devolve. */
  semearReserva(cfg: {
    hoteis?: OpcaoErp[];
    tiposUh?: OpcaoErp[];
    custoPontosPorDiaria?: number;
    taxaCentavosPorDiaria?: number;
    diasBloqueados?: string[];
    saldoPontos?: number;
  }): void;
  readonly utilizacoes: readonly UtilizacaoErp[];
  /** 045: pessoas, leads e vendas "gravados", para o teste conferir. */
  readonly pessoas: readonly { pessoaId: number; nome: string; cpf: string }[];
  readonly leads: readonly CasalErp[];
  readonly vendas: readonly { contratoId: number; input: VendaInput }[];
}

/** Diárias entre check-in e check-out (a noite é que conta). */
function diarias(checkIn: string, checkOut: string): string[] {
  const saida: string[] = [];
  for (
    let t = Date.parse(`${checkIn}T00:00:00Z`);
    t < Date.parse(`${checkOut}T00:00:00Z`);
    t += 86_400_000
  ) {
    saida.push(new Date(t).toISOString().slice(0, 10));
    if (saida.length > 90) break;
  }
  return saida;
}

export function createErpSimulado(): ErpSimulado {
  const transacoes: { input: RegistrarPagamentoInput; transacaoId: string }[] = [];
  const pessoas: { pessoaId: number; nome: string; cpf: string }[] = [];
  const leads: CasalErp[] = [];
  const vendas: { contratoId: number; input: VendaInput }[] = [];
  const parcelas = new Map<string, ParcelaErp>();
  const boletos = new Map<string, Uint8Array>();
  let seq = 0;
  // 038
  const utilizacoes: UtilizacaoErp[] = [];
  let hoteis: OpcaoErp[] = [{ id: 1, descricao: 'TORRE 1' }];
  let tiposUh: OpcaoErp[] = [{ id: 1, descricao: 'STANDARD' }];
  let custoPontosPorDiaria = 800;
  let taxaCentavosPorDiaria = 9_000;
  let diasBloqueados: string[] = [];
  let saldoPontos = 66_000;
  let seqUtilizacao = 0;

  return {
    fornecedor: 'tse',
    transacoes,

    semearBoleto(contaFinanceiraId, bytes) {
      boletos.set(contaFinanceiraId, bytes);
    },

    /**
     * 040: sem nada semeado NÃO HÁ 2ª via — e `null` aqui é a resposta certa,
     * não um buraco. Este writer é o de memória: quem desenha o boleto é o
     * dublê do fornecedor (`apps/tse-sim`), porque desenhar boleto é trabalho
     * do ERP e o produto não pode saber fazer isso. Para ver a 2ª via na demo,
     * aponte `TSE_BASE_URL` para o simulador.
     */
    async obterSegundaVia(contaFinanceiraId) {
      const bytes = boletos.get(contaFinanceiraId);
      return bytes ? { bytes, mime: 'application/pdf' } : null;
    },

    semear(p) {
      parcelas.set(p.contaFinanceiraId, p);
    },

    async registrarPagamento(entrada) {
      const i = RegistrarPagamentoInputSchema.parse(entrada);
      const atual = parcelas.get(i.contaFinanceiraId);
      if (atual === undefined) {
        throw new ErpBusinessError(
          `parcela ${i.contaFinanceiraId} não existe no ERP simulado`,
          400,
          '',
        );
      }
      seq += 1;
      const transacaoId = String(seq);
      transacoes.push({ input: i, transacaoId });
      // o simulado NÃO recusa baixa repetida: o TSE provavelmente também não, e
      // é justamente isso que o read-back do worker existe para compensar
      parcelas.set(i.contaFinanceiraId, {
        ...atual,
        pago: true,
        pagoEm: new Date().toISOString().slice(0, 10),
      });
      return { transacaoId };
    },

    async lerParcela(contaFinanceiraId) {
      return parcelas.get(contaFinanceiraId) ?? null;
    },

    // --- 038 ---------------------------------------------------------------

    utilizacoes,

    semearReserva(cfg) {
      if (cfg.hoteis) hoteis = cfg.hoteis;
      if (cfg.tiposUh) tiposUh = cfg.tiposUh;
      if (cfg.custoPontosPorDiaria !== undefined) custoPontosPorDiaria = cfg.custoPontosPorDiaria;
      if (cfg.taxaCentavosPorDiaria !== undefined)
        taxaCentavosPorDiaria = cfg.taxaCentavosPorDiaria;
      if (cfg.diasBloqueados) diasBloqueados = cfg.diasBloqueados;
      if (cfg.saldoPontos !== undefined) saldoPontos = cfg.saldoPontos;
    },

    async listarHoteis() {
      return hoteis;
    },

    async listarTiposUh() {
      return tiposUh;
    },

    async simularUtilizacao(entrada) {
      const i = SimularUtilizacaoInputSchema.parse(entrada);
      const dias = diarias(i.checkIn, i.checkOut).map((dia) => ({
        dia,
        bloqueado: diasBloqueados.includes(dia),
        periodo: 'PADRÃO',
        custoPontos: custoPontosPorDiaria,
        taxaCentavos: taxaCentavosPorDiaria,
      }));
      return {
        diarias: dias,
        custoPontos: dias.reduce((a, d) => a + d.custoPontos, 0),
        taxaCentavos: dias.reduce((a, d) => a + d.taxaCentavos, 0),
        bloqueadas: dias.filter((d) => d.bloqueado).map((d) => d.dia),
      };
    },

    async criarUtilizacao(entrada) {
      const i = CriarUtilizacaoInputSchema.parse(entrada);
      const dias = diarias(i.checkIn, i.checkOut);
      seqUtilizacao += 1;
      // o simulado NÃO recusa criação repetida: o TSE também não recusaria, e é
      // isso que o read-back do worker existe para compensar
      const nova: UtilizacaoErp = {
        id: String(seqUtilizacao),
        status: 'ATIVO',
        confirmada: false,
        custoPontos: dias.length * custoPontosPorDiaria,
        taxaCentavos: dias.length * taxaCentavosPorDiaria,
        checkIn: i.checkIn,
        checkOut: i.checkOut,
        hotel: hoteis.find((h) => h.id === i.idHotel)?.descricao ?? null,
        tipoUh: tiposUh.find((t) => t.id === i.idTipoUh)?.descricao ?? null,
        idHotel: i.idHotel,
        idTipoUh: i.idTipoUh,
        pagantes: i.adultos + i.criancas,
        operador: 'AGENTE.SETA',
      };
      utilizacoes.push(nova);
      return nova;
    },

    async confirmarUtilizacao(idUtilizacao) {
      const i = utilizacoes.findIndex((u) => u.id === idUtilizacao);
      if (i < 0) throw new ErpBusinessError(`utilização ${idUtilizacao} não existe`, 400, '');
      utilizacoes[i] = {
        ...(utilizacoes[i] as UtilizacaoErp),
        status: 'CONFIRMADA',
        confirmada: true,
      };
    },

    async cancelarUtilizacao(idUtilizacao) {
      const i = utilizacoes.findIndex((u) => u.id === idUtilizacao);
      if (i < 0) throw new ErpBusinessError(`utilização ${idUtilizacao} não existe`, 400, '');
      utilizacoes[i] = {
        ...(utilizacoes[i] as UtilizacaoErp),
        status: 'CANCELADA',
        confirmada: false,
      };
    },

    async lerUtilizacao(idUtilizacao) {
      return utilizacoes.find((u) => u.id === idUtilizacao) ?? null;
    },

    async listarUtilizacoes() {
      return [...utilizacoes];
    },

    async lerSaldoPontos() {
      return (
        saldoPontos -
        utilizacoes
          .filter((u) => u.status.toUpperCase() !== 'CANCELADA')
          .reduce((a, u) => a + u.custoPontos, 0)
      );
    },

    // --- 045: ciclo comercial -------------------------------------------------

    get pessoas() {
      return pessoas;
    },
    get leads() {
      return leads;
    },
    get vendas() {
      return vendas;
    },

    async criarPessoa(entrada) {
      const i = PessoaInputSchema.parse(entrada);
      const cpf = i.cpf.replace(/\D/g, '');
      // o CPF é chave natural aqui também: repetir não cria segunda pessoa
      const existente = pessoas.find((p) => p.cpf === cpf);
      if (existente) return { pessoaId: existente.pessoaId };
      const pessoaId = pessoas.length + 1;
      pessoas.push({ pessoaId, nome: i.nome, cpf });
      return { pessoaId };
    },

    async listarLeads() {
      return [...leads];
    },

    async criarLead(entrada) {
      const i = LeadInputSchema.parse(entrada);
      const cpf = (i.cpf ?? '').replace(/\D/g, '');
      if (cpf.length === 0) {
        throw new ErpBusinessError('lead sem CPF: o read-back do casal fica impossível', 400, '');
      }
      const existente = leads.find((c) => mesmoCasal(c, cpf));
      if (existente) return { casalId: existente.casalId };
      const casalId = leads.length + 1;
      leads.push({ casalId, nome: i.nome, cpf });
      return { casalId };
    },

    async criarVenda(entrada) {
      const i = VendaInputSchema.parse(entrada);
      const contratoId = 900_000 + vendas.length + 1;
      vendas.push({ contratoId, input: i });
      return { contratoId };
    },

    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}
