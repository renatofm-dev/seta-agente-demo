import { OutboundTextSchema } from './index.js';
import { type OutboundTemplate, OutboundTemplateSchema, payloadDeTemplate } from './template.js';

/**
 * Gateway de saída. `send` (texto livre) FALHA EXPLÍCITO se a janela de 24h
 * estiver fechada; `sendTemplate` (013) NÃO exige janela — template aprovado é
 * exatamente a forma sancionada de iniciar conversa fora dela.
 */

export class JanelaFechadaError extends Error {
  constructor(waId: string) {
    super(`janela de 24h fechada para ${waId} — envio livre proibido (template fica fora da POC)`);
    this.name = 'JanelaFechadaError';
  }
}

export interface JanelaInfo {
  /** Expiração da janela de atendimento (última msg do usuário + 24h); null = nunca abriu. */
  readonly expiraEm: Date | null;
}

export interface OutboundGateway {
  send(msg: { to: string; body: string }, janela: JanelaInfo): Promise<{ waMessageId: string }>;
  /** #013: envio de template — dispensa janela (Meta cobra por conversa iniciada). */
  sendTemplate(msg: OutboundTemplate): Promise<{ waMessageId: string }>;
}

function exigirJanelaAberta(to: string, janela: JanelaInfo): void {
  if (!janela.expiraEm || janela.expiraEm.getTime() < Date.now()) {
    throw new JanelaFechadaError(to);
  }
}

export interface MetaGatewayConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly graphVersion?: string;
  readonly fetchFn?: typeof fetch;
}

/** Implementação real: Graph API da Meta (número de teste na POC). */
export function createMetaGateway(config: MetaGatewayConfig): OutboundGateway {
  const fetchFn = config.fetchFn ?? fetch;
  const versao = config.graphVersion ?? 'v21.0';

  const postMessages = async (payload: Record<string, unknown>): Promise<string> => {
    const res = await fetchFn(
      `https://graph.facebook.com/${versao}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new Error(`Graph API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const corpo = (await res.json()) as { messages?: { id: string }[] };
    const waMessageId = corpo.messages?.[0]?.id;
    if (!waMessageId) throw new Error('Graph API sem message id na resposta');
    return waMessageId;
  };

  return {
    async send(msg, janela) {
      const valida = OutboundTextSchema.parse(msg);
      exigirJanelaAberta(valida.to, janela);
      const waMessageId = await postMessages({
        messaging_product: 'whatsapp',
        to: valida.to,
        type: 'text',
        text: { body: valida.body },
      });
      return { waMessageId };
    },
    async sendTemplate(msg) {
      const valida = OutboundTemplateSchema.parse(msg);
      const waMessageId = await postMessages(payloadDeTemplate(valida));
      return { waMessageId };
    },
  };
}

export interface LogGatewayLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Gateway dev/simulador: não fala com a Meta, só loga — mas respeita as MESMAS
 * regras (validação e janela), para o comportamento não divergir do real.
 */
export function createLogGateway(logger: LogGatewayLogger): OutboundGateway {
  let seq = 0;
  return {
    async send(msg, janela) {
      const valida = OutboundTextSchema.parse(msg);
      exigirJanelaAberta(valida.to, janela);
      seq += 1;
      const waMessageId = `sim-${Date.now()}-${seq}`;
      logger.info({ to: valida.to, waMessageId, body: valida.body }, 'envio simulado (log-only)');
      return { waMessageId };
    },
    async sendTemplate(msg) {
      const valida = OutboundTemplateSchema.parse(msg);
      seq += 1;
      const waMessageId = `sim-tpl-${Date.now()}-${seq}`;
      logger.info(
        { to: valida.to, waMessageId, template: valida.nome, variaveis: valida.variaveis },
        'template simulado (log-only)',
      );
      return { waMessageId };
    },
  };
}
