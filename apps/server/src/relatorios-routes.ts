import { type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { type Auth, sessaoDaRequest } from './auth.js';
import type { Db } from './db/index.js';
import { TZ_CLIENTE } from './tz.js';

/**
 * Relatórios do console (017): campanhas cruzadas com o que aconteceu depois
 * delas — resposta, cobrança, pagamento, escalada — e com a meta de conversão.
 *
 * Regras de atribuição (premissas registradas na spec):
 * - janela: um evento conta para a campanha se cair em
 *   [enviado_em, enviado_em + janelaDias] do destinatário;
 * - a ÚLTIMA campanha que alcançou o número (enviada de fato) leva o crédito:
 *   um evento não é atribuído a uma campanha se outra campanha chegou ao mesmo
 *   número entre o envio e o evento;
 * - o pagamento segue a cobrança: conta para a campanha à qual a cobrança foi
 *   atribuída, desde que registrado até o fim da janela;
 * - competência = mês de envio da campanha, no fuso do cliente;
 * - conversão = pagas ÷ entregues (entregue ou lido), em bps.
 */

export interface RelatoriosRoutesOpts {
  readonly db: Db;
  readonly auth: Auth;
  /** Meta global de conversão (client.yaml › campanhas.metaConversaoBps). */
  readonly metaConversaoBps: number;
}

export const JANELAS_DIAS = [7, 15, 30, 60] as const;
export type JanelaDias = (typeof JANELAS_DIAS)[number];
/** Intervalo máximo de um relatório (um ano + 1 dia de folga para bissexto). */
export const MAX_DIAS_RELATORIO = 366;

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-\d{2}$/;

const QuerySchema = z.object({
  de: z.string().regex(DIA).optional(),
  ate: z.string().regex(DIA).optional(),
  competencia: z.string().regex(MES).optional(),
  modelo: z.string().trim().min(1).max(512).optional(),
  janelaDias: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(7), z.literal(15), z.literal(30), z.literal(60)]))
    .default(30),
});

export interface ContagensCampanha {
  destinatarios: number;
  enviadas: number;
  entregues: number;
  lidas: number;
  falhas: number;
  responderam: number;
  cobrancas: number;
  pagas: number;
  valorRecuperadoCentavos: number;
  escaladas: number;
  /** Mediana de horas entre o envio e o primeiro pagamento; null sem pagamento. */
  medianaHorasPagamento: number | null;
  /** pagas ÷ entregues em bps; null sem entrega. */
  conversaoBps: number | null;
}

export interface LinhaCampanha extends ContagensCampanha {
  id: string;
  nome: string;
  modelo: string;
  status: 'enviando' | 'concluido';
  criadoEm: string;
  /** YYYY-MM no fuso do cliente. */
  competencia: string;
  metaBps: number;
}

export interface TotaisCampanhas extends ContagensCampanha {
  campanhas: number;
  /** Meta ponderada pelas entregas; sem entrega, a meta global. */
  metaBps: number;
}

export interface RelatorioCampanhas {
  filtros: {
    de: string;
    ate: string;
    competencia: string | null;
    modelo: string | null;
    janelaDias: JanelaDias;
    metaGlobalBps: number;
  };
  campanhas: LinhaCampanha[];
  totais: TotaisCampanhas;
  /** Mesma duração, imediatamente antes de `de` (sem o filtro de competência). */
  anterior: { de: string; ate: string; totais: TotaisCampanhas };
  /** Valores disponíveis para os seletores da tela (todas as campanhas). */
  opcoes: { competencias: string[]; modelos: string[] };
}

// --- datas no fuso do cliente ---------------------------------------------

/** Hoje (YYYY-MM-DD) no fuso do cliente. */
export function hojeNoFuso(agora: Date = new Date()): string {
  return agora.toLocaleDateString('en-CA', { timeZone: TZ_CLIENTE });
}

/** Soma `n` dias a um YYYY-MM-DD (aritmética em UTC, sem fuso). */
export function somarDias(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Dias entre dois YYYY-MM-DD (`ate` − `de`); negativo se invertido. */
export function diasEntre(de: string, ate: string): number {
  const [y1, m1, d1] = de.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = ate.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** YYYY-MM-DD existe no calendário (rejeita 2026-02-30). */
export function dataValida(dia: string): boolean {
  return DIA.test(dia) && somarDias(dia, 0) === dia;
}

// --- consulta ---------------------------------------------------------------

interface FiltroConsulta {
  de: string;
  ate: string;
  competencia: string | null;
  modelo: string | null;
  janelaDias: number;
  metaBps: number;
}

interface RowConsulta {
  total_row: number;
  id: string | null;
  nome: string | null;
  modelo: string | null;
  status: 'enviando' | 'concluido' | null;
  criado_em: Date | string | null;
  competencia: string | null;
  meta_bps: number | string | null;
  campanhas: number | string;
  destinatarios: number | string;
  enviadas: number | string;
  entregues: number | string;
  lidas: number | string;
  falhas: number | string;
  responderam: number | string;
  cobrancas: number | string;
  pagas: number | string;
  valor_recuperado_centavos: number | string;
  escaladas: number | string;
  mediana_horas_pagamento: number | string | null;
}

const n = (v: number | string | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);
const iso = (v: Date | string | null): string =>
  v instanceof Date ? v.toISOString() : v === null ? '' : new Date(v).toISOString();

function contagensDe(r: RowConsulta): ContagensCampanha {
  const entregues = n(r.entregues);
  const pagas = n(r.pagas);
  return {
    destinatarios: n(r.destinatarios),
    enviadas: n(r.enviadas),
    entregues,
    lidas: n(r.lidas),
    falhas: n(r.falhas),
    responderam: n(r.responderam),
    cobrancas: n(r.cobrancas),
    pagas,
    valorRecuperadoCentavos: n(r.valor_recuperado_centavos),
    escaladas: n(r.escaladas),
    medianaHorasPagamento:
      r.mediana_horas_pagamento === null || r.mediana_horas_pagamento === undefined
        ? null
        : Math.round(Number(r.mediana_horas_pagamento) * 10) / 10,
    conversaoBps: entregues > 0 ? Math.round((pagas * 10_000) / entregues) : null,
  };
}

/** Meta ponderada pelas entregas (a meta "efetiva" do conjunto). */
export function metaPonderada(
  linhas: readonly { metaBps: number; entregues: number }[],
  metaGlobalBps: number,
): number {
  const entregues = linhas.reduce((s, l) => s + l.entregues, 0);
  if (entregues === 0) return metaGlobalBps;
  return Math.round(linhas.reduce((s, l) => s + l.metaBps * l.entregues, 0) / entregues);
}

async function consultar(
  db: Db,
  f: FiltroConsulta,
): Promise<{ campanhas: LinhaCampanha[]; totais: TotaisCampanhas }> {
  // "a última campanha leva o crédito": nenhuma outra campanha ENVIADA chegou ao
  // mesmo número entre o envio desta e o evento
  const semCampanhaPosterior = (evento: SQL) => sql`NOT EXISTS (
    SELECT 1 FROM disparo_destinatario dd2
    JOIN disparo p2 ON p2.id = dd2.disparo_id
    WHERE dd2.wa_id = dest.wa_id
      AND dd2.status IN ('enviado', 'entregue', 'lido')
      AND p2.criado_em > dest.disparo_criado_em
      AND p2.criado_em <= ${evento})`;

  const r = await db.execute(sql`
    WITH camp AS (
      SELECT d.id, coalesce(d.nome, m.nome) AS nome, m.nome AS modelo, d.status, d.criado_em,
             to_char(d.criado_em AT TIME ZONE ${TZ_CLIENTE}, 'YYYY-MM') AS competencia,
             coalesce(d.meta_conversao_bps, ${f.metaBps}::int) AS meta_bps
      FROM disparo d
      JOIN modelo_mensagem m ON m.id = d.modelo_id
      WHERE (d.criado_em AT TIME ZONE ${TZ_CLIENTE})::date BETWEEN ${f.de}::date AND ${f.ate}::date
        AND (${f.competencia}::text IS NULL
             OR to_char(d.criado_em AT TIME ZONE ${TZ_CLIENTE}, 'YYYY-MM') = ${f.competencia}::text)
        AND (${f.modelo}::text IS NULL OR m.nome = ${f.modelo}::text)
    ),
    dest AS (
      SELECT dd.id, dd.disparo_id, dd.wa_id, dd.status, c.id AS conversa_id,
             camp.criado_em AS disparo_criado_em,
             coalesce(msg.criado_em, camp.criado_em) AS enviado_em,
             coalesce(msg.criado_em, camp.criado_em)
               + make_interval(days => ${f.janelaDias}::int) AS fim
      FROM disparo_destinatario dd
      JOIN camp ON camp.id = dd.disparo_id
      LEFT JOIN conversa c ON c.wa_id = dd.wa_id
      LEFT JOIN mensagem msg
        ON dd.wa_message_id IS NOT NULL AND msg.wa_message_id = dd.wa_message_id
    ),
    fatos AS (
      SELECT dest.*,
        (SELECT min(m.criado_em) FROM mensagem m
          WHERE m.conversa_id = dest.conversa_id AND m.direcao = 'in'
            AND m.criado_em BETWEEN dest.enviado_em AND dest.fim
            AND ${semCampanhaPosterior(sql`m.criado_em`)}) AS respondeu_em,
        (SELECT min(k.criado_em) FROM cobranca k
          WHERE k.conversa_id = dest.conversa_id
            AND k.criado_em BETWEEN dest.enviado_em AND dest.fim
            AND ${semCampanhaPosterior(sql`k.criado_em`)}) AS cobranca_em,
        pg.n AS pagamentos, pg.valor AS valor_pago_centavos, pg.primeiro AS pago_em,
        EXISTS (SELECT 1 FROM evento_escalonamento e
          WHERE e.conversa_id = dest.conversa_id
            AND e.criado_em BETWEEN dest.enviado_em AND dest.fim
            AND ${semCampanhaPosterior(sql`e.criado_em`)}) AS escalou
      FROM dest
      LEFT JOIN LATERAL (
        -- o pagamento segue a cobrança: conta para a campanha que gerou a cobrança
        -- (recebido_em vem do PSP com granularidade de dia; o registro é preciso)
        SELECT count(*)::int AS n,
               coalesce(sum(p.valor_centavos), 0)::bigint AS valor,
               min(p.criado_em) AS primeiro
        FROM cobranca k
        JOIN pagamento p ON p.cobranca_id = k.id
          AND p.status = 'confirmado' AND p.criado_em <= dest.fim
        WHERE k.conversa_id = dest.conversa_id
          AND k.criado_em BETWEEN dest.enviado_em AND dest.fim
          AND ${semCampanhaPosterior(sql`k.criado_em`)}
      ) pg ON true
    )
    SELECT grouping(camp.id) AS total_row,
      camp.id, camp.nome, camp.modelo, camp.status, camp.criado_em, camp.competencia, camp.meta_bps,
      count(DISTINCT camp.id)::int AS campanhas,
      count(f.id)::int AS destinatarios,
      count(*) FILTER (WHERE f.status <> 'pendente')::int AS enviadas,
      count(*) FILTER (WHERE f.status IN ('entregue', 'lido'))::int AS entregues,
      count(*) FILTER (WHERE f.status = 'lido')::int AS lidas,
      count(*) FILTER (WHERE f.status = 'falha')::int AS falhas,
      count(*) FILTER (WHERE f.respondeu_em IS NOT NULL)::int AS responderam,
      count(*) FILTER (WHERE f.cobranca_em IS NOT NULL)::int AS cobrancas,
      count(*) FILTER (WHERE f.pagamentos > 0)::int AS pagas,
      coalesce(sum(f.valor_pago_centavos), 0)::bigint AS valor_recuperado_centavos,
      count(*) FILTER (WHERE f.escalou)::int AS escaladas,
      percentile_cont(0.5) WITHIN GROUP
        (ORDER BY extract(epoch FROM (f.pago_em - f.enviado_em)) / 3600.0) AS mediana_horas_pagamento
    FROM camp
    LEFT JOIN fatos f ON f.disparo_id = camp.id
    GROUP BY GROUPING SETS (
      (camp.id, camp.nome, camp.modelo, camp.status, camp.criado_em, camp.competencia, camp.meta_bps),
      ()
    )
    ORDER BY total_row, camp.criado_em DESC
  `);
  const rows = r.rows as unknown as RowConsulta[];
  const campanhas: LinhaCampanha[] = rows
    .filter((row) => n(row.total_row) === 0)
    .map((row) => ({
      id: row.id ?? '',
      nome: row.nome ?? '',
      modelo: row.modelo ?? '',
      status: row.status ?? 'concluido',
      criadoEm: iso(row.criado_em),
      competencia: row.competencia ?? '',
      metaBps: n(row.meta_bps),
      ...contagensDe(row),
    }));
  const totalRow = rows.find((row) => n(row.total_row) === 1);
  const base: ContagensCampanha = totalRow
    ? contagensDe(totalRow)
    : {
        destinatarios: 0,
        enviadas: 0,
        entregues: 0,
        lidas: 0,
        falhas: 0,
        responderam: 0,
        cobrancas: 0,
        pagas: 0,
        valorRecuperadoCentavos: 0,
        escaladas: 0,
        medianaHorasPagamento: null,
        conversaoBps: null,
      };
  return {
    campanhas,
    totais: {
      ...base,
      campanhas: totalRow ? n(totalRow.campanhas) : 0,
      metaBps: metaPonderada(campanhas, f.metaBps),
    },
  };
}

// --- rotas ------------------------------------------------------------------

export const relatoriosRoutes: FastifyPluginCallback<RelatoriosRoutesOpts> = (app, opts, done) => {
  const { db } = opts;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const sessao = await sessaoDaRequest(opts.auth, req.headers);
    if (!sessao) return reply.code(401).send({ erro: 'não autenticado' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ erro: 'entrada inválida', detalhe: z.prettifyError(err) });
    }
    req.log.error(err, 'erro na api de relatórios');
    return reply.code(500).send({ erro: 'erro interno' });
  });

  app.get('/api/console/relatorios/campanhas', async (req, reply) => {
    const q = QuerySchema.parse(req.query);
    const hoje = hojeNoFuso();
    const ate = q.ate ?? hoje;
    const de = q.de ?? somarDias(ate, -29);
    if (!dataValida(de) || !dataValida(ate)) {
      return reply.code(400).send({ erro: 'data inexistente no calendário' });
    }
    const dias = diasEntre(de, ate) + 1;
    if (dias < 1) return reply.code(400).send({ erro: '"de" não pode ser depois de "ate"' });
    if (dias > MAX_DIAS_RELATORIO) {
      return reply
        .code(400)
        .send({ erro: `período de ${dias} dias; o máximo é ${MAX_DIAS_RELATORIO}` });
    }

    const base = {
      competencia: q.competencia ?? null,
      modelo: q.modelo ?? null,
      janelaDias: q.janelaDias,
      metaBps: opts.metaConversaoBps,
    };
    const ateAnterior = somarDias(de, -1);
    const deAnterior = somarDias(ateAnterior, -(dias - 1));
    const [atual, anterior, opcoes] = await Promise.all([
      consultar(db, { ...base, de, ate }),
      consultar(db, { ...base, competencia: null, de: deAnterior, ate: ateAnterior }),
      db.execute(sql`
        SELECT DISTINCT to_char(d.criado_em AT TIME ZONE ${TZ_CLIENTE}, 'YYYY-MM') AS competencia,
               m.nome AS modelo
        FROM disparo d JOIN modelo_mensagem m ON m.id = d.modelo_id
      `),
    ]);
    const linhasOpcoes = opcoes.rows as unknown as { competencia: string; modelo: string }[];
    const resposta: RelatorioCampanhas = {
      filtros: {
        de,
        ate,
        competencia: base.competencia,
        modelo: base.modelo,
        janelaDias: q.janelaDias,
        metaGlobalBps: opts.metaConversaoBps,
      },
      campanhas: atual.campanhas,
      totais: atual.totais,
      anterior: { de: deAnterior, ate: ateAnterior, totais: anterior.totais },
      opcoes: {
        competencias: [...new Set(linhasOpcoes.map((o) => o.competencia))].sort().reverse(),
        modelos: [...new Set(linhasOpcoes.map((o) => o.modelo))].sort(),
      },
    };
    return resposta;
  });

  done();
};
