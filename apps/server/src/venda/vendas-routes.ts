import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { type SessaoConsole, sessaoDaRequest } from '../auth.js';
import type { Db } from '../db/index.js';
import { cobranca, erpEscrita, propostaSdr, STATUS_VENDA, venda } from '../db/schema.js';
import { chaveVenda } from './chave.js';

/**
 * Console de vendas (045). Molde de `reserva/reservas-routes.ts`: auth por
 * preHandler, Zod inline, leitura paginada e um drawer com o rastro inteiro.
 *
 * **Só leitura.** Diferente de cobrança e reserva, aqui não há botão de aprovar:
 * a venda nasce de um pagamento confirmado, e o que um humano precisa é ver o
 * que aconteceu — inclusive quando o ERP recusou depois de o dinheiro entrar,
 * que é a linha mais importante desta tela.
 */

export interface VendasRoutesOpts {
  readonly db: Db;
  readonly auth: Auth;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();
const ParamsId = z.object({ id: z.uuid() });
const QueryLista = z.object({
  status: z.enum(STATUS_VENDA).optional(),
  /** Aba Vendas do painel de contexto: só as desta conversa. */
  conversaId: z.uuid().optional(),
});

/** O CPF não sai daqui inteiro: o console mostra quem é, não o documento. */
function mascararCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, '');
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '***';
}

function paraJson(linha: typeof venda.$inferSelect) {
  const c = linha.comprador as { nome: string; cpf: string };
  return {
    id: linha.id,
    conversaId: linha.conversaId,
    status: linha.status,
    comprador: { nome: c.nome, cpf: mascararCpf(c.cpf ?? '') },
    cotaCodigo: linha.cotaCodigo,
    valorCentavos: linha.valorCentavos,
    sinalCentavos: linha.sinalCentavos,
    erpContratoId: linha.erpContratoId,
    motivo: linha.motivo,
    criadoEm: linha.criadoEm,
  };
}

export const vendasRoutes: FastifyPluginCallback<VendasRoutesOpts> = (app, opts, done) => {
  const { db, auth } = opts;

  app.addHook('preHandler', async (req, reply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ erro: z.prettifyError(err) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      req.log.warn({ err }, 'requisição recusada');
      return reply.code(status).send({ erro: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ erro: 'erro interno' });
  });

  app.get('/api/console/vendas', async (req) => {
    const q = QueryLista.parse(req.query);
    // filtro no SQL, não em memória: filtrar depois do LIMIT perderia linhas
    const onde = [
      ...(q.status ? [eq(venda.status, q.status)] : []),
      ...(q.conversaId ? [eq(venda.conversaId, q.conversaId)] : []),
    ];
    const linhas = await db
      .select()
      .from(venda)
      .where(onde.length > 0 ? and(...onde) : undefined)
      .orderBy(desc(venda.criadoEm))
      .limit(200);
    return { vendas: linhas.map(paraJson) };
  });

  app.get('/api/console/vendas/:id', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const [linha] = await db.select().from(venda).where(eq(venda.id, id));
    if (!linha) return reply.code(404).send({ erro: 'venda não encontrada' });

    // o rastro que um atendente precisa quando algo deu errado
    const [escrita] = await db
      .select()
      .from(erpEscrita)
      .where(eq(erpEscrita.chave, chaveVenda(id)));
    const [cob] = linha.cobrancaId
      ? await db.select().from(cobranca).where(eq(cobranca.id, linha.cobrancaId))
      : [];
    const [proposta] = linha.propostaId
      ? await db.select().from(propostaSdr).where(eq(propostaSdr.id, linha.propostaId))
      : [];

    return {
      ...paraJson(linha),
      erpPessoaId: linha.erpPessoaId,
      erpCasalId: linha.erpCasalId,
      escrita: escrita
        ? { estado: escrita.estado, tentativas: escrita.tentativas, erro: escrita.erro }
        : null,
      cobranca: cob
        ? {
            status: cob.status,
            metodo: cob.metodo,
            valorCentavos: cob.valorCentavos,
            urlFatura: cob.urlFatura,
            pagoEm: cob.pagoEm,
          }
        : null,
      proposta: proposta
        ? {
            valorTabelaCentavos: proposta.valorTabelaCentavos,
            valorOfertadoCentavos: proposta.valorOfertadoCentavos,
            status: proposta.status,
          }
        : null,
    };
  });

  done();
};
