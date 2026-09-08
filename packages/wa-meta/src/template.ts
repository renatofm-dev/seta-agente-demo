import { z } from 'zod';

/**
 * Telefone em E.164 sem o `+`. Vive AQUI (e não no index) porque este módulo
 * o usa na inicialização — via index seria import circular com valor undefined
 * (os re-exports do index carregam gateway/template antes do corpo dele rodar).
 */
export const WaPhoneSchema = z.string().regex(/^[1-9]\d{7,14}$/, 'telefone deve ser E.164 sem +');

/**
 * Modelos de mensagem (templates) da spec 013: criação/listagem no WABA via
 * Business Management API e envio pelo /messages. Template aprovado é a ÚNICA
 * forma de iniciar conversa fora da janela de 24h — por isso `sendTemplate`
 * NÃO exige janela aberta.
 */

export const TEMPLATE_CATEGORIAS = ['utility', 'marketing'] as const;
export type TemplateCategoria = (typeof TEMPLATE_CATEGORIAS)[number];

/** Status de aprovação que a Meta devolve, normalizado para o nosso domínio. */
export const TEMPLATE_STATUS = ['pendente', 'aprovado', 'rejeitado', 'desconhecido'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUS)[number];

/** Variáveis posicionais do corpo: {{1}}..{{N}}, sem buracos na numeração. */
export function variaveisDoCorpo(corpo: string): number[] {
  const numeros = [...corpo.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(numeros)].sort((a, b) => a - b);
}

export const TemplateDefSchema = z
  .object({
    nome: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[a-z0-9_]+$/, 'nome de template: minúsculas, dígitos e _ (regra da Meta)'),
    idioma: z.string().min(2).max(15).default('pt_BR'),
    categoria: z.enum(TEMPLATE_CATEGORIAS).default('utility'),
    corpo: z.string().min(1).max(1024),
    rodape: z.string().min(1).max(60).optional(),
  })
  .superRefine((def, ctx) => {
    const vars = variaveisDoCorpo(def.corpo);
    for (const [i, n] of vars.entries()) {
      if (n !== i + 1) {
        ctx.addIssue({
          code: 'custom',
          message: `variáveis do corpo devem ser {{1}}..{{N}} sequenciais (encontrado {{${n}}})`,
          path: ['corpo'],
        });
        return;
      }
    }
  });
export type TemplateDef = z.infer<typeof TemplateDefSchema>;

export interface TemplateRemoto {
  readonly metaId: string;
  readonly nome: string;
  readonly idioma: string;
  readonly categoria: TemplateCategoria | string;
  readonly status: TemplateStatus;
  readonly motivoRejeicao: string | null;
}

/** Port de gestão de modelos no WABA (implementação real: Graph API; testes: fake). */
export interface TemplateApi {
  criar(def: TemplateDef): Promise<{ metaId: string; status: TemplateStatus }>;
  listar(): Promise<TemplateRemoto[]>;
}

const STATUS_META: Record<string, TemplateStatus> = {
  PENDING: 'pendente',
  APPROVED: 'aprovado',
  REJECTED: 'rejeitado',
};

const normalizarStatus = (s: string | undefined): TemplateStatus =>
  STATUS_META[(s ?? '').toUpperCase()] ?? 'desconhecido';

export interface MetaTemplateApiConfig {
  readonly accessToken: string;
  /** WhatsApp Business Account id (WA_WABA_ID). */
  readonly wabaId: string;
  readonly graphVersion?: string;
  readonly fetchFn?: typeof fetch;
}

export function createMetaTemplateApi(config: MetaTemplateApiConfig): TemplateApi {
  const fetchFn = config.fetchFn ?? fetch;
  const versao = config.graphVersion ?? 'v21.0';
  const base = `https://graph.facebook.com/${versao}/${config.wabaId}/message_templates`;
  const headers = {
    authorization: `Bearer ${config.accessToken}`,
    'content-type': 'application/json',
  };

  return {
    async criar(def) {
      const valida = TemplateDefSchema.parse(def);
      const components: Record<string, unknown>[] = [
        {
          type: 'BODY',
          text: valida.corpo,
          // a Meta exige exemplo quando há variáveis
          ...(variaveisDoCorpo(valida.corpo).length > 0
            ? {
                example: {
                  body_text: [variaveisDoCorpo(valida.corpo).map((n) => `exemplo ${n}`)],
                },
              }
            : {}),
        },
      ];
      if (valida.rodape) components.push({ type: 'FOOTER', text: valida.rodape });
      const res = await fetchFn(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: valida.nome,
          language: valida.idioma,
          category: valida.categoria.toUpperCase(),
          components,
        }),
      });
      if (!res.ok) {
        throw new Error(`Graph API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const corpo = (await res.json()) as { id?: string; status?: string };
      if (!corpo.id) throw new Error('Graph API sem id de template na resposta');
      return { metaId: corpo.id, status: normalizarStatus(corpo.status) };
    },

    async listar() {
      const res = await fetchFn(
        `${base}?fields=id,name,language,category,status,rejected_reason&limit=100`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`Graph API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const corpo = (await res.json()) as {
        data?: {
          id: string;
          name: string;
          language: string;
          category?: string;
          status?: string;
          rejected_reason?: string | null;
        }[];
      };
      return (corpo.data ?? []).map((t) => ({
        metaId: t.id,
        nome: t.name,
        idioma: t.language,
        categoria: (t.category ?? 'utility').toLowerCase(),
        status: normalizarStatus(t.status),
        motivoRejeicao: t.rejected_reason ?? null,
      }));
    },
  };
}

// --- envio ------------------------------------------------------------------

export const OutboundTemplateSchema = z.object({
  to: WaPhoneSchema,
  nome: z.string().min(1),
  idioma: z.string().min(2).default('pt_BR'),
  /** Valores das variáveis posicionais, na ordem {{1}}..{{N}}. */
  variaveis: z.array(z.string().min(1).max(1024)).default([]),
});
export type OutboundTemplate = z.infer<typeof OutboundTemplateSchema>;

/** Corpo do POST /messages para um template (compartilhado pelos gateways). */
export function payloadDeTemplate(msg: OutboundTemplate): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    to: msg.to,
    type: 'template',
    template: {
      name: msg.nome,
      language: { code: msg.idioma },
      ...(msg.variaveis.length > 0
        ? {
            components: [
              {
                type: 'body',
                parameters: msg.variaveis.map((texto) => ({ type: 'text', text: texto })),
              },
            ],
          }
        : {}),
    },
  };
}
