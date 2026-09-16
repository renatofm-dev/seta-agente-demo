import type { FastifyInstance } from 'fastify';
import type { Autenticador, Sessao } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Dono do token. Só existe depois do preHandler — rota sem bearer não roda. */
    sessao: Sessao;
  }
}

/**
 * Nenhum exemplo de 401 veio na coleção (os 89 são 200). Este é o corpo padrão
 * do ASP.NET Web API, que é o stack do TS Explorer — a forma que o adapter vai
 * encontrar quando o token expirar em produção.
 */
export const CORPO_401 = { Message: 'Authorization has been denied for this request.' } as const;

/**
 * Exige bearer nas rotas do escopo ONDE FOR CHAMADA. Função, não plugin de
 * `register`: `register` cria um contexto FILHO, e um hook registrado lá dentro
 * não alcança as rotas irmãs do plugin que o registrou — o efeito prático seria
 * uma API inteira aberta, que foi exatamente o que aconteceu antes desta nota.
 */
export function exigirBearer(app: FastifyInstance, auth: Autenticador): void {
  app.addHook('preHandler', async (req, reply) => {
    const sessao = auth.resolver(req.headers.authorization);
    if (!sessao) {
      await reply.code(401).send(CORPO_401);
      return;
    }
    req.sessao = sessao;
  });
}
