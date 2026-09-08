import { newTraceId } from '@seta/observability';
import {
  type TemplateApi,
  TemplateDefSchema,
  variaveisDoCorpo,
  WaPhoneSchema,
} from '@seta/wa-meta';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { ZodError, z } from 'zod';
import { type Auth, type SessaoConsole, sessaoDaRequest } from './auth.js';
import { FILA_DISPARO } from './boss.js';
import type { Db } from './db/index.js';
import { contato, disparo, disparoDestinatario, modeloMensagem } from './db/schema.js';

/**
 * API de disparos (013): modelos de mensagem criados DA PLATAFORMA (registro
 * na Meta via TemplateApi + espelho local) e disparos de template para a
 * carteira. Qualquer papel logado (premissa da POC — sem papel "marketing").
 */

export interface DisparosRoutesOpts {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly auth: Auth;
  /** null ⇒ WA_WABA_ID/token ausentes: rotas de modelo respondem 503. */
  readonly templateApi: TemplateApi | null;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();

export const disparosRoutes: FastifyPluginCallback<DisparosRoutesOpts> = (app, opts, done) => {
  const { db, boss, templateApi } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(opts.auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ erro: 'entrada inválida', detalhe: z.prettifyError(err) });
    }
    req.log.error(err, 'erro na api de disparos');
    return reply.code(500).send({ erro: 'erro interno' });
  });

  const sessaoDe = (req: FastifyRequest): SessaoConsole => {
    const s = sessoes.get(req);
    if (!s) throw new Error('sessão ausente após preHandler');
    return s;
  };

  const exigirTemplateApi = (reply: FastifyReply): TemplateApi | null => {
    if (!templateApi) {
      reply.code(503).send({
        erro: 'gestão de modelos indisponível — configure WA_WABA_ID e WA_ACCESS_TOKEN',
      });
      return null;
    }
    return templateApi;
  };

  // --- modelos --------------------------------------------------------------

  app.get('/api/console/modelos', async () => {
    const modelos = await db.select().from(modeloMensagem).orderBy(desc(modeloMensagem.criadoEm));
    return { modelos, metaConfigurada: templateApi !== null };
  });

  /** Cria o modelo NA META e persiste o espelho local (status: pendente). */
  app.post('/api/console/modelos', async (req, reply) => {
    const api = exigirTemplateApi(reply);
    if (!api) return;
    const sessao = sessaoDe(req);
    const def = TemplateDefSchema.parse(req.body);
    const [existente] = await db
      .select({ id: modeloMensagem.id })
      .from(modeloMensagem)
      .where(eq(modeloMensagem.nome, def.nome));
    if (existente) return reply.code(409).send({ erro: `modelo "${def.nome}" já existe` });

    const criado = await api.criar(def); // falha da Meta → 500 com a mensagem
    const [modelo] = await db
      .insert(modeloMensagem)
      .values({
        id: newTraceId(),
        nome: def.nome,
        idioma: def.idioma,
        categoria: def.categoria,
        corpo: def.corpo,
        rodape: def.rodape ?? null,
        metaId: criado.metaId,
        statusMeta: criado.status,
        criadoPor: sessao.userId,
      })
      .returning();
    return reply.code(201).send({ modelo });
  });

  /** Sincroniza o status de aprovação de TODOS os modelos com a Meta. */
  app.post('/api/console/modelos/sincronizar', async (_req, reply) => {
    const api = exigirTemplateApi(reply);
    if (!api) return;
    const remotos = await api.listar();
    const porNome = new Map(remotos.map((r) => [r.nome, r]));
    const locais = await db.select().from(modeloMensagem);
    let atualizados = 0;
    for (const local of locais) {
      const remoto = porNome.get(local.nome);
      if (!remoto) continue;
      if (
        remoto.status !== local.statusMeta ||
        (remoto.motivoRejeicao ?? null) !== local.motivoRejeicao
      ) {
        await db
          .update(modeloMensagem)
          .set({
            statusMeta: remoto.status,
            motivoRejeicao: remoto.motivoRejeicao,
            metaId: remoto.metaId,
            atualizadoEm: new Date(),
          })
          .where(eq(modeloMensagem.id, local.id));
        atualizados++;
      }
    }
    const modelos = await db.select().from(modeloMensagem).orderBy(desc(modeloMensagem.criadoEm));
    return { modelos, atualizados };
  });

  // --- carteira e disparos --------------------------------------------------

  /** Carteira = contatos com vínculo verificado (a audiência dos disparos). */
  app.get('/api/console/carteira', async () => {
    const contatos = await db
      .select({ waId: contato.waId, nome: contato.nome, clienteErpId: contato.clienteErpId })
      .from(contato)
      .orderBy(contato.nome);
    return { contatos };
  });

  app.post('/api/console/disparos', async (req, reply) => {
    const sessao = sessaoDe(req);
    const body = z
      .object({
        modeloId: z.uuid(),
        variaveis: z.array(z.string().min(1).max(1024)).default([]),
        waIds: z.array(WaPhoneSchema).min(1).max(500),
        /** 017: rótulo da campanha (ausente ⇒ nome do modelo). */
        nome: z.string().trim().min(1).max(80).optional(),
        /** 017: meta de conversão própria em bps (ausente ⇒ global do client.yaml). */
        metaConversaoBps: z.number().int().min(0).max(10_000).optional(),
      })
      .parse(req.body);

    const [modelo] = await db
      .select()
      .from(modeloMensagem)
      .where(eq(modeloMensagem.id, body.modeloId));
    if (!modelo) return reply.code(404).send({ erro: 'modelo inexistente' });
    if (modelo.statusMeta !== 'aprovado') {
      return reply.code(400).send({
        erro: `modelo "${modelo.nome}" não está aprovado na Meta (status: ${modelo.statusMeta})`,
      });
    }
    const esperadas = variaveisDoCorpo(modelo.corpo).length;
    if (body.variaveis.length !== esperadas) {
      return reply.code(400).send({
        erro: `o corpo do modelo tem ${esperadas} variável(is) e o disparo trouxe ${body.variaveis.length}`,
      });
    }
    // audiência restrita à carteira: wa_id desconhecido é erro, não silêncio
    const waIds = [...new Set(body.waIds)];
    const daCarteira = await db
      .select({ waId: contato.waId, nome: contato.nome })
      .from(contato)
      .where(inArray(contato.waId, waIds));
    if (daCarteira.length !== waIds.length) {
      const conhecidos = new Set(daCarteira.map((c) => c.waId));
      const fora = waIds.filter((w) => !conhecidos.has(w));
      return reply.code(400).send({ erro: `fora da carteira: ${fora.join(', ')}` });
    }

    const disparoId = newTraceId();
    await db.transaction(async (tx) => {
      await tx.insert(disparo).values({
        id: disparoId,
        modeloId: modelo.id,
        variaveis: body.variaveis,
        nome: body.nome ?? null,
        metaConversaoBps: body.metaConversaoBps ?? null,
        criadoPor: sessao.userId,
      });
      await tx.insert(disparoDestinatario).values(
        daCarteira.map((c) => ({
          id: newTraceId(),
          disparoId,
          waId: c.waId,
          contatoNome: c.nome,
        })),
      );
    });
    await boss.send(FILA_DISPARO, { disparoId });
    return reply.code(202).send({ disparoId, destinatarios: daCarteira.length });
  });

  app.get('/api/console/disparos', async () => {
    // 1 query: disparo + modelo + contagem por status via lateral (sem N+1, #31)
    const r = await db.execute(sql`
      SELECT d.id, d.status, d.variaveis, d.criado_em, d.nome, d.meta_conversao_bps,
             m.nome AS modelo_nome,
             ct.total, ct.enviados, ct.entregues, ct.lidos, ct.falhas, ct.pendentes
      FROM disparo d
      JOIN modelo_mensagem m ON m.id = d.modelo_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE dd.status = 'enviado')::int AS enviados,
               count(*) FILTER (WHERE dd.status = 'entregue')::int AS entregues,
               count(*) FILTER (WHERE dd.status = 'lido')::int AS lidos,
               count(*) FILTER (WHERE dd.status = 'falha')::int AS falhas,
               count(*) FILTER (WHERE dd.status = 'pendente')::int AS pendentes
        FROM disparo_destinatario dd WHERE dd.disparo_id = d.id
      ) ct ON true
      ORDER BY d.criado_em DESC
      LIMIT 100
    `);
    return { disparos: r.rows };
  });

  app.get('/api/console/disparos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [d] = await db.select().from(disparo).where(eq(disparo.id, id));
    if (!d) return reply.code(404).send({ erro: 'disparo inexistente' });
    const [modelo] = await db
      .select()
      .from(modeloMensagem)
      .where(eq(modeloMensagem.id, d.modeloId));
    const destinatarios = await db
      .select()
      .from(disparoDestinatario)
      .where(eq(disparoDestinatario.disparoId, id))
      .orderBy(disparoDestinatario.waId);
    return { disparo: d, modelo, destinatarios };
  });

  done();
};
