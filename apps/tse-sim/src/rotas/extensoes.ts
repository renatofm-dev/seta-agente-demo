import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Autenticador } from '../auth.js';
import { contratoPdf, type ParcelaContrato } from '../contrato-pdf.js';
import type { Banco } from '../db.js';
import { decimal, hojeTse } from '../pascal.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * EXTENSÕES DO SIMULADOR — rotas que **não existem na coleção do fornecedor**.
 *
 * Todo o resto do `tse-sim` imita uma rota real do TS Explorer, e o teste de
 * contrato compara cada uma com o exemplo salvo. Estas não têm exemplo para
 * comparar porque não têm original: a API do TSE não expõe documento de
 * contrato nem assinatura (as 90 rotas cobrem cadastro, venda, financeiro,
 * utilização e operador; as 8 ocorrências de "Assinatura" na coleção são
 * `TvAssinatura`, do formulário de lead).
 *
 * Por isso elas moram sob `/sim/`, e não sob `/api/`: quem lê um log, um teste
 * ou este arquivo daqui a seis meses precisa distinguir, sem pensar, o que é
 * contrato do fornecedor do que é invenção nossa para a demo andar. Quando o
 * fornecedor responder como o sistema dele gera o contrato (pergunta aberta na
 * spec 046), o que estiver aqui migra para `/api/` ou morre.
 */

export interface ExtensoesDeps extends FastifyPluginOptions {
  readonly db: Banco;
  readonly auth: Autenticador;
  /** Razão social que assina como vendedora no papel. */
  readonly vendedora: string;
}

interface LinhaContrato {
  readonly numerocontrato: string;
  readonly datavenda: string;
  readonly nome: string;
  readonly cpf: string;
  readonly cota_codigo: string;
  readonly tier: string;
  readonly bloco: string;
  readonly uh: string;
  readonly capacidade: number;
  readonly periodos: number;
  readonly pontos: number;
}

interface LinhaParcela {
  readonly tipo: string;
  readonly vencimento: string;
  readonly valorreceber: string;
}

export function extensoesRoutes(app: FastifyInstance, opts: ExtensoesDeps, done: () => void): void {
  exigirBearer(app, opts.auth);

  /**
   * O contrato em PDF. Mesmo contrato do `SetVenda`: o documento é desenhado a
   * partir do que a venda gravou, nunca de parâmetro de quem chama — pedir o
   * PDF não pode ser um jeito de inventar um contrato que não existe.
   */
  app.get<{ Params: { idContrato: string } }>(
    '/sim/contratos/:idContrato/documento.pdf',
    async (req, reply) => {
      const id = z.coerce.number().int().positive().parse(req.params.idContrato);

      const [contrato] = await opts.db.buscar<LinhaContrato>(
        /**
         * O mesmo join de `MeusContratos` — tabelas-base, não as `v_*`. As
         * views são o lado ESPELHO (o catálogo SQL da 012/018) e o papel
         * `tse_sim` nem tem permissão nelas: quem fala pela API do ERP lê o
         * que o ERP lê.
         */
        `SELECT c.numerocontrato, to_char(c.datavenda, 'YYYY-MM-DD') AS datavenda,
                c.qtdpontos AS pontos,
                p.nome, p.cpf,
                q.codigocota AS cota_codigo, g.nome AS tier, m.qtdperiodos AS periodos,
                e.nome AS bloco, u.numero AS uh, u.capacidade
           FROM contrato c
           JOIN pessoa p            ON p.idpessoa = c.idpessoatitular
           JOIN cotauh q            ON q.idcotauh = coalesce(c.idcotaativa, c.idcotaadquirida)
           JOIN grupocota g         ON g.idgrupocota = q.idgrupocota
           JOIN modelocota m        ON m.idmodelocota = q.idmodelocota
           JOIN unidadehoteleira u  ON u.idunidadehoteleira = q.idunidadehoteleira
           JOIN edificiohotel e     ON e.idedificiohotel = u.idedificiohotel
          WHERE c.idcontrato = :id`,
        { id },
      );
      if (!contrato) {
        return reply.code(404).send({ Message: 'Contrato nao encontrado.' });
      }

      const parcelas = await opts.db.buscar<LinhaParcela>(
        `SELECT t.nome AS tipo,
                to_char(coalesce(cf.datavencimentorecorrencia, cf.datavencimento),
                        'YYYY-MM-DD') AS vencimento,
                cf.valorreceber
           FROM contafinanceira cf
           JOIN tipoorigemcontafinanceira t
             ON t.idtipoorigemcontafinanceira = cf.idtipoorigemcontafinanceira
          WHERE cf.idcontrato = :id AND cf.tipohistorico = 'ATIVO'
          ORDER BY cf.datavencimento`,
        { id },
      );

      const linhas: ParcelaContrato[] = parcelas.map((p) => ({
        tipo: p.tipo,
        vencimento: p.vencimento,
        valorReais: decimal(p.valorreceber),
      }));

      const pdf = contratoPdf({
        vendedora: opts.vendedora,
        numeroContrato: contrato.numerocontrato,
        dataVenda: contrato.datavenda,
        compradorNome: contrato.nome,
        compradorCpf: contrato.cpf,
        cotaCodigo: contrato.cota_codigo,
        tier: contrato.tier,
        unidade: `${contrato.bloco} · apto ${contrato.uh} · até ${contrato.capacidade} hóspedes`,
        periodos: contrato.periodos,
        pontos: contrato.pontos,
        valorTotalReais: linhas.reduce((t, p) => t + p.valorReais, 0),
        parcelas: linhas,
        emitidoEm: hojeTse(),
      });
      return reply.code(200).type('application/pdf').send(pdf);
    },
  );

  done();
}
