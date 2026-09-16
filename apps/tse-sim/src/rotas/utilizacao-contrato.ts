import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { Autenticador } from '../auth.js';
import type { Consulta } from '../db.js';
import { decimal } from '../pascal.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `utilizacaocontrato/*` — a porta de entrada da reserva no TS Explorer (035).
 * Desta fatia só entra `obtercontratos`, que é como o operador acha o contrato
 * a partir do CPF: é a leitura que NÃO passa pelo painel do cliente e, por
 * isso, a única que responde a D10 na prática — se o painel resolver escopo
 * pelo token, é por aqui que o agente ainda enxerga o cotista certo.
 * O resto de `utilizacaocontrato/*` chega com a 038.
 */

export interface UtilizacaoDeps extends FastifyPluginOptions {
  readonly db: Consulta;
  readonly auth: Autenticador;
}

export function utilizacaoContratoRoutes(
  app: FastifyInstance,
  opts: UtilizacaoDeps,
  done: () => void,
): void {
  exigirBearer(app, opts.auth);

  app.get<{ Querystring: { cpf?: string } }>(
    '/api/utilizacaocontrato/obtercontratos',
    async (req) => {
      const linhas = await opts.db.buscar<Record<string, unknown>>(
        `SELECT c.idcontrato, c.numerocontrato, c.statuscontrato, c.qtdpontos,
                (SELECT coalesce(sum(valorreceber), 0) FROM contafinanceira f
                  WHERE f.idcontrato = c.idcontrato AND f.tipohistorico = 'ATIVO') AS negociado
           FROM contrato c
           JOIN pessoa p ON p.idpessoa = c.idpessoatitular
          WHERE regexp_replace(p.cpf, '\\D', '', 'g') = regexp_replace(:cpf, '\\D', '', 'g')
          ORDER BY c.idcontrato`,
        { cpf: req.query.cpf ?? '' },
      );
      return linhas.map((c) => ({
        IdContrato: c.idcontrato,
        NumeroContrato: c.numerocontrato,
        Status: c.statuscontrato,
        QtdPontosLiberados: c.qtdpontos,
        ObrigaLancamentoPensaoUtilizacaoContrato: false,
        QtdMinimaDiariasUtilizacaoContrato: 0,
        ValorNegociado: decimal(c.negociado as string),
      }));
    },
  );

  done();
}
