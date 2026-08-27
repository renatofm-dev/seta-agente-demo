import type { FastifyPluginCallback } from 'fastify';
import type { Auth } from './auth.js';

/**
 * Monta o handler web (Request/Response) do Better Auth no Fastify.
 * Plugin encapsulado com parser de corpo BRUTO — o handler consome o body.
 */

export interface AuthRoutesOpts {
  readonly auth: Auth;
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOpts> = (app, opts, done) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, cb) =>
    cb(null, body),
  );

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? (req.body as Buffer | undefined) : undefined,
      });
      const response = await opts.auth.handler(request);

      reply.status(response.status);
      response.headers.forEach((valor, chave) => {
        if (chave === 'set-cookie') return; // tratado abaixo (múltiplos)
        reply.header(chave, valor);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    },
  });

  done();
};
