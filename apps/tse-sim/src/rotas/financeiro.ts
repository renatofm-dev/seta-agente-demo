import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Autenticador } from '../auth.js';
import type { Banco } from '../db.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `financeiro/*` — a ESCRITA (035). É por aqui que a demo deixa de fingir:
 * `TransacaoEletronica` grava a baixa em `contafinanceira`, e a mesma parcela
 * aparece `pago` em `v_titulo` no instante seguinte, porque a API e o catálogo
 * leem a MESMA base. É o que mata a conciliação inventada da 014 (036).
 *
 * O TSE responde a estas três rotas com uma FRASE, não com um objeto — e com
 * `content-type: application/json`, ou seja, uma string JSON. Copiado como é:
 * o adapter da 036 vai ter que extrair o id de dentro do texto, e descobrir
 * isso agora é melhor do que descobrir em produção.
 */

export interface FinanceiroDeps extends FastifyPluginOptions {
  readonly db: Banco;
  readonly auth: Autenticador;
}

const TransacaoSchema = z.object({
  IdContaFinanceira: z.number().int().positive(),
  Valor: z.number(),
  QuatroPrimeirosDigitosCartao: z.string().max(4).nullish(),
  QuatroUltimosDigitosCartao: z.string().max(4).nullish(),
  CodigoAutorizacao: z.string().max(40).nullish(),
  QuantidadeParcelas: z.number().int().min(1).default(1),
  NomePessoa: z.string().max(120).nullish(),
});

const ContaFinanceiraSchema = z.object({
  IdContrato: z.number().int().positive(),
  IdTipoOrigemContaFinanceira: z.number().int().positive().default(2),
  IdMeioPagamento: z.number().int().positive().default(1),
  DataVencimento: z.iso.date(),
  ValorReceber: z.number(),
  QuantidadeParcelas: z.number().int().min(1).max(360).default(1),
});

/**
 * A alteração é declarada CAMPO A CAMPO, e não com `ContaFinanceiraSchema.partial()`:
 * `.partial()` do Zod deixa o `.default()` de pé, e um PUT sem `IdMeioPagamento`
 * voltaria com `1` — reescrevendo a parcela para boleto em silêncio. Aqui, campo
 * ausente é `undefined`, e `coalesce` no SQL preserva o valor que já estava lá.
 */
const AlteracaoSchema = z.object({
  IdContaFinanceira: z.number().int().positive().optional(),
  IdContrato: z.number().int().positive().optional(),
  IdTipoOrigemContaFinanceira: z.number().int().positive().optional(),
  IdMeioPagamento: z.number().int().positive().optional(),
  DataVencimento: z.iso.date().optional(),
  ValorReceber: z.number().optional(),
  QuantidadeParcelas: z.number().int().min(1).max(360).optional(),
});

/** O envelope do TSE para estas rotas é uma string JSON, não um objeto. */
function frase(reply: FastifyReply, texto: string): FastifyReply {
  return reply.type('application/json; charset=utf-8').send(JSON.stringify(texto));
}

export function financeiroRoutes(
  app: FastifyInstance,
  opts: FinanceiroDeps,
  done: () => void,
): void {
  exigirBearer(app, opts.auth);

  app.post('/api/financeiro/TransacaoEletronica', async (req, reply) => {
    const corpo = TransacaoSchema.parse(req.body);
    const id = await opts.db.transacao(async (tx) => {
      const [conta] = await tx.buscar<{ idcontafinanceira: number }>(
        'SELECT idcontafinanceira FROM contafinanceira WHERE idcontafinanceira = :id',
        { id: corpo.IdContaFinanceira },
      );
      if (!conta) return null;
      const [nova] = await tx.buscar<{ idtransacaoeletronica: number }>(
        `INSERT INTO tse_sim.transacaoeletronica
           (idcontafinanceira, valor, quatroprimeirosdigitoscartao, quatroultimosdigitoscartao,
            codigoautorizacao, quantidadeparcelas, nomepessoa)
         VALUES (:id, :valor, :primeiros, :ultimos, :autorizacao, :parcelas, :nome)
         RETURNING idtransacaoeletronica`,
        {
          id: corpo.IdContaFinanceira,
          valor: corpo.Valor,
          primeiros: corpo.QuatroPrimeirosDigitosCartao ?? null,
          ultimos: corpo.QuatroUltimosDigitosCartao ?? null,
          autorizacao: corpo.CodigoAutorizacao ?? null,
          parcelas: corpo.QuantidadeParcelas,
          nome: corpo.NomePessoa ?? null,
        },
      );
      // a baixa: é ESTA linha que faz v_titulo.status virar 'pago' na leitura
      // seguinte do catálogo, sem nenhuma camada de conciliação no meio
      await tx.buscar(
        `UPDATE contafinanceira
            SET datarecebimento = current_date,
                valorrecebido = :valor
          WHERE idcontafinanceira = :id`,
        { id: corpo.IdContaFinanceira, valor: corpo.Valor },
      );
      return nova?.idtransacaoeletronica ?? null;
    });
    if (id === null) {
      return reply.code(400).send({ Message: 'Conta financeira não encontrada.' });
    }
    return frase(reply, `Transação inserida com sucesso, sob id: ${id}`);
  });

  app.post('/api/financeiro/ContaFinanceira', async (req, reply) => {
    const corpo = ContaFinanceiraSchema.parse(req.body);
    const ids = await opts.db.transacao(async (tx) => {
      const criadas: number[] = [];
      for (let parcela = 1; parcela <= corpo.QuantidadeParcelas; parcela++) {
        const [linha] = await tx.buscar<{ idcontafinanceira: number }>(
          `INSERT INTO contafinanceira
             (idcontrato, idtipoorigemcontafinanceira, idmeiopagamento, numeroparcela,
              qtdparcelas, valorreceber, datavencimento, tipohistorico)
           VALUES (:idContrato, :origem, :meio, :parcela, :total, :valor,
                   :vencimento::date + make_interval(months => :meses), 'ATIVO')
           RETURNING idcontafinanceira`,
          {
            idContrato: corpo.IdContrato,
            origem: corpo.IdTipoOrigemContaFinanceira,
            meio: corpo.IdMeioPagamento,
            parcela,
            total: corpo.QuantidadeParcelas,
            valor: corpo.ValorReceber,
            vencimento: corpo.DataVencimento,
            meses: parcela - 1,
          },
        );
        if (linha) criadas.push(linha.idcontafinanceira);
      }
      return criadas;
    });
    return frase(reply, `Contas financeiras criadas sob ids: ${ids.join(', ')}`);
  });

  app.put<{ Params: { id: string } }>('/api/financeiro/ContaFinanceira/:id', async (req, reply) => {
    const corpo = AlteracaoSchema.parse(req.body);
    const alteradas = await opts.db.buscar<{ idcontafinanceira: number }>(
      `UPDATE contafinanceira
            SET valorreceber   = coalesce(:valor, valorreceber),
                datavencimento = coalesce(:vencimento::date, datavencimento),
                idmeiopagamento = coalesce(:meio, idmeiopagamento)
          WHERE idcontafinanceira = :id
          RETURNING idcontafinanceira`,
      {
        id: Number(req.params.id),
        valor: corpo.ValorReceber ?? null,
        vencimento: corpo.DataVencimento ?? null,
        meio: corpo.IdMeioPagamento ?? null,
      },
    );
    if (alteradas.length === 0) {
      return reply.code(400).send({ Message: 'Conta financeira não encontrada.' });
    }
    return frase(reply, 'Conta financeira alterada.');
  });

  done();
}
