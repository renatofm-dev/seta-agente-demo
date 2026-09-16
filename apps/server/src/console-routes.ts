import type { ClientConfig } from '@seta/client-config';
import { TransicaoInvalidaError } from '@seta/crm';
import { newTraceId } from '@seta/observability';
import type { Executor } from '@seta/query-catalog';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { ZodError, z } from 'zod';
import { type Auth, type SessaoConsole, sessaoDaRequest } from './auth.js';
import type { Db } from './db/index.js';
import {
  contato,
  conversa,
  conversaLeitura,
  disparo,
  disparoDestinatario,
  mensagem,
  modeloMensagem,
  outbox,
  sinalAprendizado,
  ticket,
  traceTurno,
  turno,
  user,
} from './db/schema.js';
import { TZ_CLIENTE } from './tz.js';
import { agendarDebounce } from './wa/inbound.js';
import { enqueueOutbound } from './wa/outbox.js';
import { aplicarTransicao, garantirTicket } from './wa/tickets.js';

/**
 * API do console HITL (007/#45): atendimento centrado em CONVERSA (lista com
 * não-lidas, thread paginada, prefixo do atendente no envio), ações
 * assumir/responder/devolver/resolver, trace e SSE.
 * Toda rota exige sessão Better Auth (papéis atendente|curador).
 */

/**
 * O que a instalação expõe ao console (cabeçalho, nav por módulo e a tela
 * Configurações, só leitura): nome, módulos, limites e alçadas vêm do
 * client.yaml + env — nunca segredos.
 */
export interface InstalacaoInfo {
  readonly nome: string;
  readonly modulos: ClientConfig['modulos'];
  readonly limites: ClientConfig['limites'];
  readonly guardrails: ClientConfig['guardrails'];
  readonly alcadas: {
    readonly tetoAprovacaoCentavos: number;
    readonly maxCobrancasDia: number;
    readonly diasVencimento: number;
    readonly descontoMaxBps: number;
    readonly maxPropostasDia: number;
    /** 038: acima disto a taxa da reserva espera aprovação. */
    readonly tetoTaxaReservaCentavos: number;
  };
  readonly canal: {
    readonly gateway: 'meta' | 'log-only';
    readonly metaConfigurada: boolean;
    readonly simulador: boolean;
  };
  readonly psp: { readonly nome: string; readonly ambiente: string } | null;
  /** 017: meta global de conversão das campanhas (client.yaml). */
  readonly campanhas: { readonly metaConversaoBps: number };
}

export interface ConsoleRoutesOpts {
  readonly db: Db;
  readonly boss: PgBoss;
  readonly auth: Auth;
  readonly executor: Executor;
  readonly debounceMs: number;
  /** maxCaracteresResposta da config do cliente — orçamento da resposta manual. */
  readonly limiteResposta: number;
  /** Preço por 1M de tokens para o custo estimado do /metricas (010). */
  readonly precos: { readonly inPor1M: number; readonly outPor1M: number };
  readonly instalacao: InstalacaoInfo;
}

/** Motivos que o atendente pode marcar no 👎 (console › Aprendizado). */
const MOTIVOS_FEEDBACK = [
  'tom_inadequado',
  'informacao_errada',
  'devia_ter_escalado',
  'nao_devia_ter_escalado',
  'resposta_longa',
] as const;
const BodyFeedback = z.object({
  avaliacao: z.enum(['bom', 'ruim']),
  motivos: z.array(z.enum(MOTIVOS_FEEDBACK)).max(MOTIVOS_FEEDBACK.length).default([]),
  sugestao: z.string().trim().max(2000).optional(),
});

/** Teto duro da Meta Cloud API para corpo de texto. */
const TETO_META = 4096;

/** Prefixo da Parte B do #45: nome de quem atende, em negrito, no topo. */
export function prefixarAtendente(nome: string, texto: string): string {
  return `*${nome}*\n\n${texto}`;
}

const sessoes = new WeakMap<FastifyRequest, SessaoConsole>();

/** Último draft descartado por block/escalate nos eventos do trace (#34). */
function draftDescartadoDe(eventos: unknown): string | null {
  if (!Array.isArray(eventos)) return null;
  const verdicts = eventos.filter(
    (e): e is { tipo: string; draftDescartado?: string } =>
      typeof e === 'object' && e !== null && (e as { tipo?: string }).tipo === 'verdict',
  );
  const ultimo = verdicts.at(-1)?.draftDescartado;
  return typeof ultimo === 'string' && ultimo.length > 0 ? ultimo : null;
}

async function ticketComContexto(db: Db, t: typeof ticket.$inferSelect) {
  const [conv] = await db.select().from(conversa).where(eq(conversa.id, t.conversaId));
  const [vinculo] = conv
    ? await db.select().from(contato).where(eq(contato.waId, conv.waId))
    : [undefined];
  const [ultima] = await db
    .select()
    .from(mensagem)
    .where(eq(mensagem.conversaId, t.conversaId))
    .orderBy(desc(mensagem.criadoEm))
    .limit(1);
  return {
    id: t.id,
    conversaId: t.conversaId,
    status: t.status,
    atendenteId: t.atendenteId,
    motivoEscalonamento: t.motivoEscalonamento,
    esperaSegundos: t.escaladoEm ? Math.round((Date.now() - t.escaladoEm.getTime()) / 1000) : null,
    waId: conv?.waId ?? null,
    contatoNome: vinculo?.nome ?? null,
    clienteErpId: vinculo?.clienteErpId ?? null,
    ultimaMensagem: ultima
      ? { texto: ultima.texto, autor: ultima.autor, em: ultima.criadoEm }
      : null,
  };
}

interface HubConsole {
  assinar(fn: (pacote: string) => void): () => void;
}

/** #31: broadcaster único de eventos do console (tickets + mensagens). */
function criarHubConsole(db: Db, avisar: (obj: unknown, msg: string) => void): HubConsole {
  const assinantes = new Set<(pacote: string) => void>();
  const vistos = new Set<string>();
  let cursorTicket = new Date();
  let cursorMsg = new Date();
  let timer: NodeJS.Timeout | null = null;
  const recuo = (d: Date) => new Date(d.getTime() - 1_000);

  const emitir = (pacote: string) => {
    for (const fn of assinantes) fn(pacote);
  };
  const lembrar = (chave: string): boolean => {
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    if (vistos.size > 2_000) vistos.clear(); // cursor + recuo seguram o dedupe
    return true;
  };

  const tick = async () => {
    try {
      const tickets = await db
        .select()
        .from(ticket)
        .where(gt(ticket.atualizadoEm, recuo(cursorTicket)))
        .orderBy(asc(ticket.atualizadoEm))
        .limit(200);
      for (const t of tickets) {
        cursorTicket = t.atualizadoEm;
        if (!lembrar(`${t.id}:${t.atualizadoEm.getTime()}:${t.status}`)) continue;
        emitir(`event: ticket\ndata: ${JSON.stringify(await ticketComContexto(db, t))}\n\n`);
      }
      const msgs = await db
        .select()
        .from(mensagem)
        .where(gt(mensagem.criadoEm, recuo(cursorMsg)))
        .orderBy(asc(mensagem.criadoEm))
        .limit(200);
      for (const m of msgs) {
        cursorMsg = m.criadoEm;
        if (!lembrar(m.id)) continue;
        emitir(
          `event: mensagem\ndata: ${JSON.stringify({
            id: m.id,
            conversaId: m.conversaId,
            direcao: m.direcao,
            autor: m.autor,
            texto: m.texto,
            status: m.status,
            criadoEm: m.criadoEm,
          })}\n\n`,
        );
      }
    } catch (err) {
      avisar({ err }, 'sse console: falha na consulta');
    }
  };

  return {
    assinar(fn) {
      assinantes.add(fn);
      if (!timer) timer = setInterval(tick, 1_000); // só roda com alguém ouvindo
      return () => {
        assinantes.delete(fn);
        if (assinantes.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

export const consoleRoutes: FastifyPluginCallback<ConsoleRoutesOpts> = (app, opts, done) => {
  const { db, boss, auth, executor } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
    sessoes.set(req, sessao);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof TransicaoInvalidaError) {
      return reply.code(409).send({ erro: err.message });
    }
    if (err instanceof ZodError) {
      // #37: input inválido é 400 do cliente, não 500 no log de erro
      return reply.code(400).send({ erro: 'entrada inválida', detalhe: z.prettifyError(err) });
    }
    req.log.error(err, 'erro na api do console');
    return reply.code(500).send({ erro: 'erro interno' });
  });
  const sessaoDe = (req: FastifyRequest): SessaoConsole => {
    const s = sessoes.get(req);
    if (!s) throw new Error('sessão ausente após preHandler');
    return s;
  };

  app.get('/api/console/me', async (req) => sessaoDe(req));

  /** Cabeçalho + Configurações (só leitura): nome, módulos, limites e alçadas. */
  app.get('/api/console/instalacao', async () => opts.instalacao);

  /** Badges da barra: o que espera gente (fila, cobranças e propostas acima da alçada). */
  app.get('/api/console/resumo', async () => {
    const [r] = (
      await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM ticket WHERE status = 'aguardando_humano') AS aguardando_humano,
          (SELECT count(*)::int FROM cobranca WHERE status = 'aguardando_aprovacao') AS cobrancas_aprovacao,
          (SELECT count(*)::int FROM proposta_sdr WHERE status = 'aguardando_aprovacao') AS leads_aprovacao
      `)
    ).rows as {
      aguardando_humano: number;
      cobrancas_aprovacao: number;
      leads_aprovacao: number;
    }[];
    return {
      aguardandoHumano: r?.aguardando_humano ?? 0,
      cobrancasAguardandoAprovacao: r?.cobrancas_aprovacao ?? 0,
      leadsAguardandoAprovacao: r?.leads_aprovacao ?? 0,
    };
  });

  /** Configurações › Equipe: quem tem acesso ao console (Better Auth). */
  app.get('/api/console/equipe', async () => {
    const pessoas = await db
      .select({
        id: user.id,
        nome: user.name,
        email: user.email,
        role: user.role,
        criadoEm: user.createdAt,
      })
      .from(user)
      .orderBy(asc(user.name));
    return { pessoas };
  });

  app.get('/api/console/inbox', async (req) => {
    const sessao = sessaoDe(req);
    // #31: era 1 + 3 queries POR ticket a cada poll de cada atendente — agora
    // 1 query com lateral p/ a última mensagem, com teto de 200 tickets
    const r = await db.execute(sql`
      SELECT t.id, t.conversa_id, t.status, t.atendente_id, t.motivo_escalonamento,
             t.escalado_em, c.wa_id, ct.nome AS contato_nome, ct.cliente_erp_id,
             um.texto AS ultima_texto, um.autor AS ultima_autor, um.criado_em AS ultima_em
      FROM ticket t
      JOIN conversa c ON c.id = t.conversa_id
      LEFT JOIN contato ct ON ct.wa_id = c.wa_id
      LEFT JOIN LATERAL (
        SELECT m.texto, m.autor, m.criado_em FROM mensagem m
        WHERE m.conversa_id = t.conversa_id ORDER BY m.criado_em DESC LIMIT 1
      ) um ON true
      WHERE t.status IN ('bot_ativo', 'aguardando_humano', 'humano_ativo')
      ORDER BY t.atualizado_em DESC
      LIMIT 200
    `);
    const agora = Date.now();
    const enriquecidos = (
      r.rows as {
        id: string;
        conversa_id: string;
        status: 'bot_ativo' | 'aguardando_humano' | 'humano_ativo' | 'resolvido';
        atendente_id: string | null;
        motivo_escalonamento: string | null;
        escalado_em: Date | null;
        wa_id: string;
        contato_nome: string | null;
        cliente_erp_id: string | null;
        ultima_texto: string | null;
        ultima_autor: string | null;
        ultima_em: Date | null;
      }[]
    ).map((linha) => ({
      id: linha.id,
      conversaId: linha.conversa_id,
      status: linha.status,
      atendenteId: linha.atendente_id,
      motivoEscalonamento: linha.motivo_escalonamento,
      esperaSegundos: linha.escalado_em
        ? Math.round((agora - new Date(linha.escalado_em).getTime()) / 1000)
        : null,
      waId: linha.wa_id,
      contatoNome: linha.contato_nome,
      clienteErpId: linha.cliente_erp_id,
      ultimaMensagem: linha.ultima_texto
        ? { texto: linha.ultima_texto, autor: linha.ultima_autor, em: linha.ultima_em }
        : null,
    }));
    return {
      botAtivo: enriquecidos.filter((t) => t.status === 'bot_ativo'),
      aguardando: enriquecidos.filter((t) => t.status === 'aguardando_humano'),
      meus: enriquecidos.filter(
        (t) => t.status === 'humano_ativo' && t.atendenteId === sessao.userId,
      ),
    };
  });

  // #45: listagem centrada em CONVERSA (todas, não só escaladas) — UMA query
  // com laterals (última mensagem + não-lidas do usuário); nada de N+1 (#31)
  app.get('/api/console/conversas', async (req) => {
    const sessao = sessaoDe(req);
    const { filtro, q, limite, offset } = z
      .object({
        filtro: z.enum(['todas', 'aguardando', 'minhas', 'agente', 'resolvidas']).default('todas'),
        q: z.string().trim().max(80).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query ?? {});

    const porFiltro = {
      todas: sql`true`,
      aguardando: sql`t.status = 'aguardando_humano'`,
      minhas: sql`t.status = 'humano_ativo' AND t.atendente_id = ${sessao.userId}`,
      // conversa sem ticket ainda é do agente (o ticket nasce na 1ª escalada/abertura)
      agente: sql`coalesce(t.status, 'bot_ativo') = 'bot_ativo'`,
      resolvidas: sql`t.status = 'resolvido'`,
    }[filtro];
    // busca por nome OU telefone (só os dígitos do termo casam contra o wa_id)
    const digitos = (q ?? '').replaceAll(/\D/g, '');
    const busca = q
      ? sql`(coalesce(ct.nome, '') ILIKE ${`%${q}%`} OR c.wa_id LIKE ${`%${digitos.length > 0 ? digitos : q}%`})`
      : sql`true`;

    const r = await db.execute(sql`
      SELECT c.id AS conversa_id, c.wa_id, c.janela_expira_em,
             ct.nome AS contato_nome, ct.cliente_erp_id,
             t.id AS ticket_id, coalesce(t.status, 'bot_ativo') AS status,
             t.atendente_id, u.name AS atendente_nome,
             t.motivo_escalonamento, t.escalado_em,
             um.texto AS ultima_texto, um.autor AS ultima_autor, um.criado_em AS ultima_em,
             coalesce(nl.n, 0) AS nao_lidas
      FROM conversa c
      LEFT JOIN contato ct ON ct.wa_id = c.wa_id
      LEFT JOIN ticket t ON t.conversa_id = c.id
      LEFT JOIN "user" u ON u.id = t.atendente_id
      LEFT JOIN conversa_leitura cl ON cl.conversa_id = c.id AND cl.user_id = ${sessao.userId}
      LEFT JOIN LATERAL (
        SELECT m.texto, m.autor, m.criado_em FROM mensagem m
        WHERE m.conversa_id = c.id ORDER BY m.criado_em DESC LIMIT 1
      ) um ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n FROM mensagem m
        WHERE m.conversa_id = c.id AND m.direcao = 'in'
          AND m.criado_em > coalesce(cl.lida_ate, 'epoch'::timestamptz)
      ) nl ON true
      WHERE ${porFiltro} AND ${busca}
      ORDER BY coalesce(um.criado_em, c.criado_em) DESC
      LIMIT ${limite} OFFSET ${offset}
    `);
    const agora = Date.now();
    const conversas = (
      r.rows as {
        conversa_id: string;
        wa_id: string;
        janela_expira_em: Date | null;
        contato_nome: string | null;
        cliente_erp_id: string | null;
        ticket_id: string | null;
        status: 'bot_ativo' | 'aguardando_humano' | 'humano_ativo' | 'resolvido';
        atendente_id: string | null;
        atendente_nome: string | null;
        motivo_escalonamento: string | null;
        escalado_em: Date | null;
        ultima_texto: string | null;
        ultima_autor: string | null;
        ultima_em: Date | null;
        nao_lidas: number;
      }[]
    ).map((linha) => ({
      conversaId: linha.conversa_id,
      waId: linha.wa_id,
      contatoNome: linha.contato_nome,
      clienteErpId: linha.cliente_erp_id,
      ticketId: linha.ticket_id,
      status: linha.status,
      atendenteId: linha.atendente_id,
      atendenteNome: linha.atendente_nome,
      motivoEscalonamento: linha.motivo_escalonamento,
      esperaSegundos: linha.escalado_em
        ? Math.round((agora - new Date(linha.escalado_em).getTime()) / 1000)
        : null,
      janelaExpiraEm: linha.janela_expira_em,
      naoLidas: linha.nao_lidas,
      ultimaMensagem: linha.ultima_texto
        ? { texto: linha.ultima_texto, autor: linha.ultima_autor, em: linha.ultima_em }
        : null,
    }));

    // contagem por filtro (chips da lista) — global, sem a busca `q`
    const porStatus = (
      await db.execute(sql`
        SELECT coalesce(t.status, 'bot_ativo') AS status, count(*)::int AS n,
               count(*) FILTER (WHERE t.atendente_id = ${sessao.userId})::int AS minhas
        FROM conversa c LEFT JOIN ticket t ON t.conversa_id = c.id
        GROUP BY 1
      `)
    ).rows as { status: string; n: number; minhas: number }[];
    const n = (status: string) => porStatus.find((r) => r.status === status)?.n ?? 0;
    const contagens = {
      todas: porStatus.reduce((s, r) => s + r.n, 0),
      aguardando: n('aguardando_humano'),
      minhas: porStatus.find((r) => r.status === 'humano_ativo')?.minhas ?? 0,
      agente: n('bot_ativo'),
      resolvidas: n('resolvido'),
    };
    return { conversas, temMais: conversas.length === limite, contagens };
  });

  // #45: detalhe da conversa com thread paginada (rolagem infinita via antesDe)
  app.get('/api/console/conversa/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { antesDe, limite } = z
      .object({
        antesDe: z.iso.datetime({ offset: true }).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const [conv] = await db.select().from(conversa).where(eq(conversa.id, id));
    if (!conv) return reply.code(404).send({ erro: 'conversa inexistente' });
    const t = await garantirTicket(db, id); // toda conversa é acionável na tela

    const pagina = await db
      .select({
        id: mensagem.id,
        autor: mensagem.autor,
        atendenteId: mensagem.atendenteId,
        atendenteNome: user.name,
        texto: mensagem.texto,
        status: mensagem.status,
        criadoEm: mensagem.criadoEm,
      })
      .from(mensagem)
      .leftJoin(user, eq(user.id, mensagem.atendenteId))
      .where(
        antesDe
          ? and(eq(mensagem.conversaId, id), lt(mensagem.criadoEm, new Date(antesDe)))
          : eq(mensagem.conversaId, id),
      )
      .orderBy(desc(mensagem.criadoEm))
      .limit(limite + 1);
    const temMais = pagina.length > limite;
    const mensagens = pagina.slice(0, limite).reverse();

    // páginas antigas não pagam o custo do vínculo/ERP — só a carga inicial
    if (antesDe) return { mensagens, temMais };

    const [vinculo] = await db.select().from(contato).where(eq(contato.waId, conv.waId));
    const [atendente] = t.atendenteId
      ? await db.select({ name: user.name }).from(user).where(eq(user.id, t.atendenteId))
      : [undefined];
    let perfilErp: Record<string, unknown> | null = null;
    // painel de contexto: resumo da inadimplência (vem no rodapé de cada linha
    // de titulos_atraso; lista vazia = contrato em dia)
    let financeiro: {
      vencidas: number;
      saldoVencidoCentavos: number;
      maiorAtrasoDias: number;
      vencimentoMaisAntigo: string | null;
    } | null = null;
    if (vinculo?.clienteErpId) {
      try {
        const sessaoErp = { traceId: newTraceId(), clienteId: vinculo.clienteErpId };
        const [produto, cota, atraso] = await Promise.all([
          executor.run('contrato.meu_produto', {}, sessaoErp),
          executor.run('contrato.minha_cota', {}, sessaoErp),
          opts.instalacao.modulos.financeiro
            ? executor.run('financeiro.titulos_atraso', {}, sessaoErp)
            : Promise.resolve(null),
        ]);
        const combinado = {
          ...(produto.rows[0] as Record<string, unknown> | undefined),
          ...(cota.rows[0] as Record<string, unknown> | undefined),
        };
        perfilErp = Object.keys(combinado).length > 0 ? combinado : null;
        if (atraso) {
          const r = atraso.rows[0] as Record<string, unknown> | undefined;
          financeiro = {
            vencidas: Number(r?.qtd_titulos_vencidos ?? 0),
            saldoVencidoCentavos: Number(r?.saldo_vencido_centavos ?? 0),
            maiorAtrasoDias: Number(r?.maior_atraso_dias ?? 0),
            vencimentoMaisAntigo: r?.vencimento_mais_antigo
              ? String(
                  r.vencimento_mais_antigo instanceof Date
                    ? r.vencimento_mais_antigo.toISOString()
                    : r.vencimento_mais_antigo,
                ).slice(0, 10)
              : null,
          };
        }
      } catch (err) {
        req.log.warn({ err }, 'perfil ERP indisponível para o painel');
      }
    }
    // aba Origem: a campanha (disparo) mais recente que alcançou este número
    const [destinatario] = await db
      .select({
        disparoId: disparoDestinatario.disparoId,
        statusDestinatario: disparoDestinatario.status,
        modelo: modeloMensagem.nome,
        enviadoEm: disparo.criadoEm,
      })
      .from(disparoDestinatario)
      .innerJoin(disparo, eq(disparo.id, disparoDestinatario.disparoId))
      .innerJoin(modeloMensagem, eq(modeloMensagem.id, disparo.modeloId))
      .where(eq(disparoDestinatario.waId, conv.waId))
      .orderBy(desc(disparo.criadoEm))
      .limit(1);
    return {
      conversaId: conv.id,
      waId: conv.waId,
      contatoNome: vinculo?.nome ?? null,
      clienteErpId: vinculo?.clienteErpId ?? null,
      janelaExpiraEm: conv.janelaExpiraEm,
      limiteResposta: Math.min(TETO_META, opts.limiteResposta),
      financeiro,
      origem: destinatario ?? null,
      ticket: {
        id: t.id,
        status: t.status,
        atendenteId: t.atendenteId,
        atendenteNome: atendente?.name ?? null,
        motivoEscalonamento: t.motivoEscalonamento,
        esperaSegundos: t.escaladoEm
          ? Math.round((Date.now() - t.escaladoEm.getTime()) / 1000)
          : null,
      },
      mensagens,
      temMais,
      perfilErp,
    };
  });

  // #45: marca de leitura por atendente — zera o badge de não-lidas
  app.post('/api/console/conversa/:id/lida', async (req, reply) => {
    const sessao = sessaoDe(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [conv] = await db.select({ id: conversa.id }).from(conversa).where(eq(conversa.id, id));
    if (!conv) return reply.code(404).send({ erro: 'conversa inexistente' });
    const agora = new Date();
    await db
      .insert(conversaLeitura)
      .values({ conversaId: id, userId: sessao.userId, lidaAte: agora })
      .onConflictDoUpdate({
        target: [conversaLeitura.conversaId, conversaLeitura.userId],
        set: { lidaAte: agora },
      });
    return { ok: true };
  });

  app.get('/api/console/ticket/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [t] = await db.select().from(ticket).where(eq(ticket.id, id));
    if (!t) return reply.code(404).send({ erro: 'ticket inexistente' });
    const contexto = await ticketComContexto(db, t);
    const mensagens = await db
      .select()
      .from(mensagem)
      .where(eq(mensagem.conversaId, t.conversaId))
      .orderBy(asc(mensagem.criadoEm));

    // painel lateral: dados do contrato via catálogo (produto + cota da 012)
    let perfilErp: Record<string, unknown> | null = null;
    if (contexto.clienteErpId) {
      try {
        const sessaoErp = { traceId: newTraceId(), clienteId: contexto.clienteErpId };
        const [produto, cota] = await Promise.all([
          executor.run('contrato.meu_produto', {}, sessaoErp),
          executor.run('contrato.minha_cota', {}, sessaoErp),
        ]);
        const combinado = {
          ...(produto.rows[0] as Record<string, unknown> | undefined),
          ...(cota.rows[0] as Record<string, unknown> | undefined),
        };
        perfilErp = Object.keys(combinado).length > 0 ? combinado : null;
      } catch (err) {
        req.log.warn({ err }, 'perfil ERP indisponível para o painel');
      }
    }
    return {
      ...contexto,
      mensagens: mensagens.map((m) => ({
        id: m.id,
        autor: m.autor,
        texto: m.texto,
        status: m.status,
        criadoEm: m.criadoEm,
      })),
      perfilErp,
    };
  });

  const carregarTicket = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [t] = await db.select().from(ticket).where(eq(ticket.id, id));
    if (!t) {
      await reply.code(404).send({ erro: 'ticket inexistente' });
      return null;
    }
    return t;
  };

  app.post('/api/console/ticket/:id/assumir', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const atualizado = await aplicarTransicao(db, t, 'humano_ativo', 'atendente', {
      atorId: sessao.userId,
    });
    return { status: atualizado.status };
  });

  app.post('/api/console/ticket/:id/devolver', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const atualizado = await aplicarTransicao(db, t, 'bot_ativo', 'atendente', {
      atorId: sessao.userId,
    });
    // reativa o bot: varre mensagens pendentes acumuladas durante o atendimento
    await agendarDebounce(boss, t.conversaId, opts.debounceMs);
    return { status: atualizado.status };
  });

  app.post('/api/console/ticket/:id/resolver', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const atualizado = await aplicarTransicao(db, t, 'resolvido', 'atendente', {
      atorId: sessao.userId,
    });
    // #46: resolvido também reabre o bot — varre pendentes como o devolver faz
    // (antes, mensagem mandada durante o atendimento ficava parada até o
    // contato escrever de novo)
    await agendarDebounce(boss, t.conversaId, opts.debounceMs);
    return { status: atualizado.status };
  });

  app.post('/api/console/ticket/:id/responder', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    if (t.status !== 'humano_ativo' || t.atendenteId !== sessao.userId) {
      return reply.code(409).send({ erro: 'ticket não está sob seu atendimento' });
    }
    const body = z
      .object({ texto: z.string().min(1).max(TETO_META), chave: z.string().min(8).max(64) })
      .parse(req.body);

    // #45: janela de 24h fechada bloqueia AQUI, com explicação — antes o envio
    // falhava em silêncio no worker (outbox.status janela_fechada) e o
    // atendente não descobria
    const [conv] = await db.select().from(conversa).where(eq(conversa.id, t.conversaId));
    if (!conv?.janelaExpiraEm || conv.janelaExpiraEm.getTime() <= Date.now()) {
      return reply.code(409).send({
        erro: 'janela de 24h fechada — a Meta só aceita template de reengajamento (fora da POC)',
      });
    }

    // Parte B do #45: nome de quem atende em negrito no topo, SÓ quando muda
    // quem fala (mensagens consecutivas do mesmo atendente não repetem).
    // A última linha do outbox é a fonte (existe já no enfileiramento — a
    // `mensagem` só nasce depois do envio, o que criaria corrida).
    const [ultimaSaida] = await db
      .select({ autor: outbox.autor, atendenteId: outbox.atendenteId })
      .from(outbox)
      .where(eq(outbox.conversaId, t.conversaId))
      .orderBy(desc(outbox.criadoEm))
      .limit(1);
    const mesmoAtendente =
      ultimaSaida?.autor === 'atendente' && ultimaSaida.atendenteId === sessao.userId;
    const textoEntregue = mesmoAtendente ? body.texto : prefixarAtendente(sessao.nome, body.texto);
    const teto = Math.min(TETO_META, opts.limiteResposta);
    if (textoEntregue.length > teto) {
      return reply.code(400).send({
        erro: `resposta excede o limite de ${teto} caracteres (o prefixo com seu nome conta no orçamento)`,
      });
    }

    // sinal de correção HITL (insumo da 009): primeira resposta do atendente
    // desde a escalada é pareada ao último draft/resposta do bot
    const sinaisDestaEscalada = t.escaladoEm
      ? await db
          .select({ id: sinalAprendizado.id })
          .from(sinalAprendizado)
          .where(
            and(
              eq(sinalAprendizado.ticketId, t.id),
              eq(sinalAprendizado.tipo, 'correcao_hitl'),
              gt(sinalAprendizado.criadoEm, t.escaladoEm),
            ),
          )
          .limit(1)
      : [];
    if (sinaisDestaEscalada.length === 0) {
      // #47: com o bot ativo na fila, o trace MAIS RECENTE pode ser um assunto
      // qualquer — o par do sinal é o trace DA ESCALADA (escalado = true);
      // fallback para o último quando a escalada não veio de um turno (ex.:
      // falha de entrega marcou o ticket)
      const [traceDaEscalada] = await db
        .select()
        .from(traceTurno)
        .where(and(eq(traceTurno.conversaId, t.conversaId), eq(traceTurno.escalado, true)))
        .orderBy(desc(traceTurno.criadoEm))
        .limit(1);
      const [ultimoTrace] = traceDaEscalada
        ? [traceDaEscalada]
        : await db
            .select()
            .from(traceTurno)
            .where(eq(traceTurno.conversaId, t.conversaId))
            .orderBy(desc(traceTurno.criadoEm))
            .limit(1);
      await db.insert(sinalAprendizado).values({
        id: newTraceId(),
        tipo: 'correcao_hitl',
        ticketId: t.id,
        conversaId: t.conversaId,
        payload: {
          // #34: bloqueio/escalate descarta o draft real — parear com ELE, não
          // com o texto boilerplate de transição que foi ao contato
          draftBot: draftDescartadoDe(ultimoTrace?.eventos) ?? ultimoTrace?.resposta ?? null,
          traceTurnoId: ultimoTrace?.id ?? null,
          respostaHumano: body.texto,
          motivoEscalonamento: t.motivoEscalonamento,
          atendenteId: sessao.userId,
        },
      });
    }

    const r = await enqueueOutbound(
      { db, boss },
      {
        conversaId: t.conversaId,
        chave: body.chave,
        // persiste-se o texto ENTREGUE (com prefixo): o histórico do console
        // reflete o que o cliente realmente viu (decisão registrada no #45)
        texto: textoEntregue,
        autor: 'atendente',
        atendenteId: sessao.userId,
      },
    );
    return reply.code(202).send(r);
  });

  // trace viewer (010): reconstitui qualquer turno da conversa sem tocar no banco
  app.get('/api/console/ticket/:id/traces', async (req, reply) => {
    const sessao = sessaoDe(req);
    const t = await carregarTicket(req, reply);
    if (!t) return;
    const { limite } = z
      .object({ limite: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query ?? {});
    const traces = await db
      .select({
        id: traceTurno.id,
        traceId: traceTurno.traceId,
        turnoId: traceTurno.turnoId,
        textoTurno: turno.textoAgregado,
        contexto: traceTurno.contexto,
        eventos: traceTurno.eventos,
        resposta: traceTurno.resposta,
        escalado: traceTurno.escalado,
        fallback: traceTurno.fallback,
        fallbackMotivo: traceTurno.fallbackMotivo,
        tokensEntrada: traceTurno.tokensEntrada,
        tokensSaida: traceTurno.tokensSaida,
        latenciaMs: traceTurno.latenciaMs,
        criadoEm: traceTurno.criadoEm,
        // 👍/👎 que ESTE usuário já deu ao turno (console › Aprendizado)
        feedback: sql<{ avaliacao: string; motivos: string[]; sugestao: string | null } | null>`(
          SELECT jsonb_build_object(
            'avaliacao', s.payload ->> 'avaliacao',
            'motivos', coalesce(s.payload -> 'motivos', '[]'::jsonb),
            'sugestao', s.payload ->> 'sugestao'
          )
          FROM sinal_aprendizado s
          WHERE s.tipo = 'feedback_atendente'
            AND s.payload ->> 'traceTurnoId' = ${traceTurno.id}::text
            AND s.payload ->> 'atendenteId' = ${sessao.userId}
          ORDER BY s.criado_em DESC LIMIT 1
        )`,
      })
      .from(traceTurno)
      .leftJoin(turno, eq(turno.id, traceTurno.turnoId))
      .where(eq(traceTurno.conversaId, t.conversaId))
      .orderBy(desc(traceTurno.criadoEm)) // #37: os N mais RECENTES…
      .limit(limite);
    traces.reverse(); // …em ordem cronológica p/ o viewer
    return { traces };
  });

  /**
   * Feedback do atendente sobre um turno: vira sinal `feedback_atendente`
   * (insumo do distiller da 009, no mesmo formato da correção HITL — texto do
   * cotista, resposta do bot e a sugestão humana). Um por atendente×turno:
   * repetir substitui e reabre o sinal para a próxima rodada.
   */
  app.post('/api/console/traces/:id/feedback', async (req, reply) => {
    const sessao = sessaoDe(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = BodyFeedback.parse(req.body);
    const [trace] = await db
      .select({
        id: traceTurno.id,
        conversaId: traceTurno.conversaId,
        resposta: traceTurno.resposta,
        textoTurno: turno.textoAgregado,
      })
      .from(traceTurno)
      .leftJoin(turno, eq(turno.id, traceTurno.turnoId))
      .where(eq(traceTurno.id, id));
    if (!trace) return reply.code(404).send({ erro: 'turno inexistente' });
    const [tk] = await db
      .select({ id: ticket.id })
      .from(ticket)
      .where(eq(ticket.conversaId, trace.conversaId));
    const sugestao = body.sugestao && body.sugestao.length > 0 ? body.sugestao : null;
    const payload = {
      refId: trace.id,
      traceTurnoId: trace.id,
      avaliacao: body.avaliacao,
      motivos: body.motivos,
      // chave de cluster do distiller: 1º motivo marcado, ou a avaliação
      motivo: body.motivos[0] ?? (body.avaliacao === 'bom' ? 'resposta_boa' : 'resposta_ruim'),
      sugestao,
      textoUsuario: trace.textoTurno,
      respostaBot: trace.resposta,
      respostaHumano: sugestao,
      atendenteId: sessao.userId,
    };
    const [existente] = await db
      .select({ id: sinalAprendizado.id })
      .from(sinalAprendizado)
      .where(
        and(
          eq(sinalAprendizado.tipo, 'feedback_atendente'),
          sql`${sinalAprendizado.payload} ->> 'traceTurnoId' = ${trace.id}`,
          sql`${sinalAprendizado.payload} ->> 'atendenteId' = ${sessao.userId}`,
        ),
      )
      .limit(1);
    if (existente) {
      await db
        .update(sinalAprendizado)
        .set({ payload, processadoEm: null })
        .where(eq(sinalAprendizado.id, existente.id));
    } else {
      await db.insert(sinalAprendizado).values({
        id: newTraceId(),
        tipo: 'feedback_atendente',
        ticketId: tk?.id ?? null,
        conversaId: trace.conversaId,
        payload,
      });
    }
    return {
      ok: true,
      feedback: { avaliacao: body.avaliacao, motivos: body.motivos, sugestao },
    };
  });

  // métricas (010): agregados por janela de 7/30 dias
  app.get('/api/console/metricas', async (req) => {
    const { dias } = z
      .object({
        dias: z.coerce
          .number()
          .int()
          .pipe(z.union([z.literal(7), z.literal(30)])),
      })
      .parse({ dias: (req.query as { dias?: string }).dias ?? '7' });
    const desde = sql`now() - make_interval(days => ${dias})`;

    // #37: bucket de "dia" no fuso do cliente, não em UTC (virava às 21h)
    const conversasPorDia = (
      await db.execute(sql`
        SELECT to_char(date_trunc('day', criado_em AT TIME ZONE ${TZ_CLIENTE}), 'YYYY-MM-DD') AS dia,
               count(DISTINCT conversa_id)::int AS conversas
        FROM trace_turno WHERE criado_em >= ${desde} GROUP BY 1 ORDER BY 1
      `)
    ).rows as { dia: string; conversas: number }[];

    const tokensPorDia = (
      (
        await db.execute(sql`
          SELECT to_char(date_trunc('day', criado_em AT TIME ZONE ${TZ_CLIENTE}), 'YYYY-MM-DD') AS dia,
                 sum(tokens_entrada)::int AS entrada, sum(tokens_saida)::int AS saida
          FROM evento_llm WHERE criado_em >= ${desde} GROUP BY 1 ORDER BY 1
        `)
      ).rows as { dia: string; entrada: number; saida: number }[]
    ).map((r) => ({
      ...r,
      custo:
        (r.entrada / 1_000_000) * opts.precos.inPor1M +
        (r.saida / 1_000_000) * opts.precos.outPor1M,
    }));

    const escalonamentosPorMotivo = (
      await db.execute(sql`
        SELECT motivo, count(*)::int AS total
        FROM evento_escalonamento WHERE criado_em >= ${desde}
        GROUP BY motivo ORDER BY total DESC
      `)
    ).rows as { motivo: string; total: number }[];

    const [totais] = (
      await db.execute(sql`
        SELECT
          (SELECT count(DISTINCT conversa_id)::int FROM trace_turno WHERE criado_em >= ${desde}) AS conversas,
          (SELECT count(DISTINCT cid)::int FROM (
             SELECT conversa_id AS cid FROM evento_escalonamento WHERE criado_em >= ${desde}
             UNION
             SELECT tk.conversa_id FROM evento_ticket et
             JOIN ticket tk ON tk.id = et.ticket_id
             WHERE et.para_status = 'humano_ativo' AND et.criado_em >= ${desde}
           ) com_humano) AS escaladas,
          (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
             FROM evento_query WHERE criado_em >= ${desde}) AS p95_query_ms,
          (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_ms)
             FROM trace_turno WHERE criado_em >= ${desde}) AS p95_turno_ms
      `)
    ).rows as {
      conversas: number;
      escaladas: number;
      p95_query_ms: number | null;
      p95_turno_ms: number | null;
    }[];

    return {
      dias,
      conversasPorDia,
      tokensPorDia,
      escalonamentosPorMotivo,
      totalConversas: totais?.conversas ?? 0,
      totalEscaladas: totais?.escaladas ?? 0,
      // premissa (#37): "sem humano" = sem escalonamento E sem assumir direto
      // (humano_ativo); conversas em andamento ainda contam — corte consciente
      taxaResolucaoSemHumano:
        totais && totais.conversas > 0
          ? (totais.conversas - totais.escaladas) / totais.conversas
          : null,
      p95QueryMs: totais?.p95_query_ms ?? null,
      p95TurnoMs: totais?.p95_turno_ms ?? null,
      custoTotal: tokensPorDia.reduce((s, r) => s + r.custo, 0),
    };
  });

  // #31: UM poller por processo (não por conexão) — N atendentes deixam de
  // multiplicar queries; cursores nascem em AGORA (nada de despejar a tabela
  // inteira na conexão) e toda consulta tem LIMIT.
  const hub = criarHubConsole(db, (obj, msg) => app.log.warn(obj, msg));
  app.get('/api/console/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': conectado\n\n');
    const cancelar = hub.assinar((pacote) => reply.raw.write(pacote));
    req.raw.on('close', cancelar);
  });

  done();
};
