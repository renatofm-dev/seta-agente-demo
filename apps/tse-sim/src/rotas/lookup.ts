import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { Autenticador } from '../auth.js';
import { exigirBearer } from '../plugin-bearer.js';

/**
 * `Lookup/*` — as 17 tabelas de domínio do TS Explorer (bancos, bandeiras de
 * cartão, origens de venda, indexadores…), servidas DIRETO das fixtures.
 *
 * Não há o que derivar do erp_mock: são listas fixas do produto do fornecedor,
 * e qualquer versão "nossa" seria invenção. Servir o exemplo salvo é, aqui, a
 * resposta mais fiel possível — e é o que faz o teste de contrato valer alguma
 * coisa nas rotas que o adapter (039) vai consumir sem conferir duas vezes.
 */

const CONTRATO = join(import.meta.dirname, '../../contrato');

interface EntradaIndice {
  readonly nome: string;
  readonly pasta: string;
  readonly method: string;
  readonly path: string;
  readonly arquivo: string;
}

/** `{{idBandeira}}` da coleção vira `:idBandeira` do Fastify. */
function rotaFastify(path: string): string {
  return path.replace(/\{\{(\w+)\}\}/g, ':$1');
}

export function carregarLookups(): { rota: string; corpo: unknown }[] {
  const indice = JSON.parse(
    readFileSync(join(CONTRATO, 'indice.json'), 'utf-8'),
  ) as EntradaIndice[];
  const vistos = new Set<string>();
  const saida: { rota: string; corpo: unknown }[] = [];
  for (const e of indice) {
    if (e.pasta !== 'Lookups' || e.method !== 'GET') continue;
    const rota = rotaFastify(e.path);
    if (vistos.has(rota)) continue;
    vistos.add(rota);
    const fixture = JSON.parse(readFileSync(join(CONTRATO, e.arquivo), 'utf-8')) as {
      body: unknown;
    };
    saida.push({ rota, corpo: fixture.body });
  }
  return saida;
}

export interface LookupDeps extends FastifyPluginOptions {
  readonly auth: Autenticador;
}

export function lookupRoutes(app: FastifyInstance, opts: LookupDeps, done: () => void): void {
  exigirBearer(app, opts.auth);
  for (const { rota, corpo } of carregarLookups()) {
    app.get(rota, async (_req, reply) =>
      // `ConsultarNumeroVersao` devolve uma STRING JSON ("17.8.24.2003"), não um
      // objeto — e o Fastify serializa string como text/plain. O TSE manda
      // application/json nas duas; sem este desvio o adapter recebe o
      // content-type errado justamente na rota que ele usa para se orientar.
      typeof corpo === 'string'
        ? reply.type('application/json; charset=utf-8').send(JSON.stringify(corpo))
        : corpo,
    );
  }
  done();
}
