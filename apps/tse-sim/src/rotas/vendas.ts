import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Autenticador } from '../auth.js';
import type { Banco } from '../db.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `vendats/SetVenda` — a venda que vira contrato de multipropriedade (045).
 *
 * É a escrita mais consequente da frente inteira: cria `contrato`, marca a
 * `cotauh` como VENDIDA e abre as parcelas em `contafinanceira`. Depois dela,
 * `obtercontratos?cpf=` devolve o contrato novo e o cotista existe para todo o
 * resto do produto — catálogo, cobrança e reserva.
 *
 * Duas fidelidades ao fornecedor que o teste de contrato trava:
 *
 * 1. **A resposta é PROSA**: `"IdContrato: 285"`. Não é JSON com campo, não é
 *    header `Location`. O adapter extrai por regex estrita e trata 200 com
 *    prosa inesperada como erro — 200 não é sinônimo de sucesso aqui.
 * 2. **O corpo é enorme e quase todo opcional** (financiamento, indexador,
 *    multa de cancelamento, gerente de sala). O simulador exige só o que
 *    precisa para gravar e ignora o resto: recusar o que o TSE aceita faria o
 *    adapter passar contra o dublê e falhar contra o real.
 */

export interface VendasDeps extends FastifyPluginOptions {
  readonly db: Banco;
  readonly auth: Autenticador;
}

const recusar = (reply: FastifyReply, mensagem: string) =>
  reply.code(400).send({ Message: mensagem });

const frase = (reply: FastifyReply, texto: string): FastifyReply =>
  reply.type('application/json; charset=utf-8').send(JSON.stringify(texto));

/**
 * Uma conta financeira do corpo: é daqui que saem as parcelas do contrato.
 * `ValorReceber` e `ValorParcela` são os dois nomes que a coleção usa para a
 * mesma coisa; o simulador aceita qualquer um dos dois.
 */
const ContaSchema = z.object({
  IdMeioPagamento: z.number().int().positive(),
  IdTipoOrigemContaFinanceira: z.number().int().positive(),
  DataVencimento: z.string().min(8),
  ValorReceber: z.number().nonnegative().nullish(),
  ValorParcela: z.number().nonnegative().nullish(),
  QuantidadeParcelas: z.number().int().positive().nullish(),
});

const SetVendaSchema = z
  .object({
    DataCadastro: z.string().nullish(),
    IdCasal: z.number().int().nullish(),
    IdComprador1: z.number().int().positive(),
    IdProduto: z.number().int().positive(),
    IdCotaUh: z.number().int().positive(),
    ValorNegociado: z.number().nonnegative(),
    ContasFinanceirasAddUpdt: z.array(ContaSchema).default([]),
  })
  .passthrough();

/**
 * `QtdPontosContrato` por produto, lido da fixture de `Lookup/Produtos` — a
 * mesma lista que o simulador serve na rota. O contrato de multipropriedade é
 * híbrido (cota + pontos) e `contrato.qtdpontos` é NOT NULL: sem esta tabela o
 * simulador teria que inventar um número, que é justamente o que ele não faz.
 */
function pontosPorProduto(): ReadonlyMap<number, number> {
  const arquivo = join(
    import.meta.dirname,
    '../../contrato/fixtures/lookups__getting-products.json',
  );
  const { body } = JSON.parse(readFileSync(arquivo, 'utf-8')) as {
    body: { IdProduto: number; QtdPontosContrato: number }[];
  };
  return new Map(body.map((p) => [p.IdProduto, p.QtdPontosContrato]));
}

export function vendasRoutes(app: FastifyInstance, opts: VendasDeps, done: () => void): void {
  exigirBearer(app, opts.auth);
  const pontos = pontosPorProduto();

  /** O `0` do path é do fornecedor (id do item, 0 = nova venda). */
  app.post('/api/vendats/SetVenda/:id', async (req, reply) => {
    const v = SetVendaSchema.parse(req.body);

    const [cota] = await opts.db.buscar<{ idcotauh: number; statuscota: string }>(
      'SELECT idcotauh, statuscota FROM cotauh WHERE idcotauh = :id',
      { id: v.IdCotaUh },
    );
    if (!cota) return recusar(reply, 'Cota não encontrada.');
    if (cota.statuscota !== 'DISPONIVEL') {
      return recusar(reply, `Cota indisponível para venda: ${cota.statuscota}.`);
    }

    const [pessoa] = await opts.db.buscar<{ idpessoa: number }>(
      'SELECT idpessoa FROM pessoa WHERE idpessoa = :id',
      { id: v.IdComprador1 },
    );
    if (!pessoa) return recusar(reply, 'Comprador não encontrado.');

    const qtdPontos = pontos.get(v.IdProduto);
    if (qtdPontos === undefined) return recusar(reply, 'Produto não encontrado.');

    const idContrato = await opts.db.transacao(async (tx) => {
      const [novo] = await tx.buscar<{ idcontrato: number }>(
        `INSERT INTO contrato
           (numerocontrato, idpessoatitular, idcotaadquirida, idcotaativa,
            statuscontrato, datavenda, qtdpontos)
         VALUES ('', :titular, :cota, :cota, 'ATIVO',
                 coalesce(:venda::date, current_date), :pontos)
         RETURNING idcontrato`,
        {
          titular: v.IdComprador1,
          cota: v.IdCotaUh,
          venda: v.DataCadastro ?? null,
          pontos: qtdPontos,
        },
      );
      const id = novo?.idcontrato as number;
      // o espelho usa o próprio id como número do contrato (seed da 012)
      await tx.buscar('UPDATE contrato SET numerocontrato = :numero WHERE idcontrato = :id', {
        numero: String(id),
        id,
      });
      // a cota sai do estoque: sem isto ela continuaria em v_cota_disponivel e
      // o SDR ofereceria a mesma unidade para o próximo lead
      await tx.buscar(`UPDATE cotauh SET statuscota = 'VENDIDA' WHERE idcotauh = :cota`, {
        cota: v.IdCotaUh,
      });

      const contas = v.ContasFinanceirasAddUpdt;
      let numero = 0;
      for (const c of contas) {
        numero += 1;
        const valor = c.ValorReceber ?? c.ValorParcela ?? 0;
        await tx.buscar(
          `INSERT INTO contafinanceira
             (idcontrato, idtipoorigemcontafinanceira, idmeiopagamento, numeroparcela,
              qtdparcelas, valorreceber, valorrecebido, datavencimento, tipohistorico)
           VALUES (:contrato, :origem, :meio, :numero, :qtd, :valor, NULL,
                   :vencimento::date, 'ATIVO')`,
          {
            contrato: id,
            origem: c.IdTipoOrigemContaFinanceira,
            meio: c.IdMeioPagamento,
            numero,
            qtd: contas.length,
            valor,
            vencimento: c.DataVencimento.slice(0, 10),
          },
        );
      }
      return id;
    });

    return frase(reply, `IdContrato: ${idContrato}`);
  });

  done();
}
