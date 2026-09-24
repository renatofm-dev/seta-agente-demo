import { and, eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { assinatura } from '../db/schema.js';
import { type AssinaturaDeps, registrarEventoAssinatura } from './fluxo.js';
import { paginaAssinada, paginaDeAssinatura, paginaSimples } from './pagina.js';

/**
 * 046 — as duas portas públicas da assinatura.
 *
 * `GET /assinar/:id` é a página que o comprador abre no celular, e ela só
 * existe no provedor SIMULADO: com o Autentique, o link leva para a tela
 * deles. `POST /webhooks/assinatura` é por onde o aceite volta — do Autentique
 * de verdade, ou do formulário da nossa própria página.
 *
 * Nenhuma das duas tem sessão: o comprador não é usuário do console. Quem faz
 * as vezes de segredo é o **id do documento**, 32 hex que só quem recebeu a
 * mensagem conhece — é isso que impede alguém de assinar contrato alheio. E o
 * webhook só encosta em linha que já existe: evento de documento desconhecido
 * é ignorado com 200, porque provedor que recebe erro re-tenta para sempre.
 */

export interface AssinaturaRoutesOpts extends AssinaturaDeps {
  /** Nome do cliente no topo da página — o mesmo do `client.yaml`. */
  readonly cliente: string;
}

const ParamsId = z.object({ id: z.string().min(8).max(200) });

export const assinaturaRoutes: FastifyPluginCallback<AssinaturaRoutesOpts> = (app, opts, done) => {
  const deps: AssinaturaDeps = {
    db: opts.db,
    boss: opts.boss,
    logger: opts.logger,
    provider: opts.provider,
    erp: opts.erp,
  };

  const achar = async (documentoId: string) => {
    const [linha] = await opts.db
      .select()
      .from(assinatura)
      .where(
        and(eq(assinatura.provedor, opts.provider.nome), eq(assinatura.documentoId, documentoId)),
      );
    return linha;
  };

  app.get('/assinar/:id', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const linha = await achar(id);
    if (!linha) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(paginaSimples(opts.cliente, 'Link não encontrado', 'Confira se abriu o link certo.'));
    }
    if (linha.estado === 'assinada') {
      return reply.type('text/html; charset=utf-8').send(paginaAssinada(opts.cliente, linha));
    }
    return reply.type('text/html; charset=utf-8').send(paginaDeAssinatura(opts.cliente, linha));
  });

  /**
   * O aceite da página simulada. Ela poderia chamar o fluxo direto, mas passa
   * pelo `lerEvento` do provider de propósito: assim o caminho que a demo
   * exercita é o MESMO que o Autentique vai usar, e não um atalho que só
   * funciona aqui.
   */
  app.post('/assinar/:id', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const evento = opts.provider.lerEvento({ documento: id, estado: 'assinada' });
    if (!evento) return reply.code(400).send({ erro: 'provedor não reconhece este aceite' });

    const r = await registrarEventoAssinatura(deps, evento);
    if (r === 'ignorado') {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(paginaSimples(opts.cliente, 'Link não encontrado', 'Confira se abriu o link certo.'));
    }
    const linha = await achar(id);
    return reply
      .type('text/html; charset=utf-8')
      .send(
        linha
          ? paginaAssinada(opts.cliente, linha)
          : paginaSimples(opts.cliente, 'Contrato assinado', 'Pode voltar para a conversa.'),
      );
  });

  /**
   * O contrato em PDF, para ler ANTES de assinar. Guardado pelo mesmo segredo
   * do link, e buscado no ERP na hora: os bytes não são guardados aqui, como
   * manda a 040.
   */
  app.get('/assinar/:id/contrato.pdf', async (req, reply) => {
    const { id } = ParamsId.parse(req.params);
    const linha = await achar(id);
    if (!linha) return reply.code(404).send({ erro: 'não encontrado' });
    const doc = await opts.erp.obterContratoPdf(linha.contratoErpId);
    if (!doc) {
      opts.logger.error(
        { contratoErpId: linha.contratoErpId },
        'assinatura: ERP não devolveu o contrato para leitura',
      );
      return reply.code(503).send({ erro: 'documento indisponível no ERP' });
    }
    return reply.type('application/pdf').send(Buffer.from(doc.bytes));
  });

  app.post('/webhooks/assinatura', async (req, reply) => {
    const evento = opts.provider.lerEvento(req.body);
    if (!evento) {
      req.log.warn({ corpo: req.body }, 'webhook assinatura: corpo não reconhecido');
      // 200 de propósito: corpo estranho não melhora com re-tentativa
      return reply.code(200).send({ recebido: true, aplicado: false });
    }
    const r = await registrarEventoAssinatura(deps, evento);
    req.log.info(
      { documentoId: evento.idDocumento, estado: evento.estado, resultado: r },
      'webhook assinatura',
    );
    return reply.code(200).send({ recebido: true, aplicado: r === 'aplicado' });
  });

  done();
};
