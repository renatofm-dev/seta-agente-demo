import { criarPostMessages, GRAPH_VERSAO_DEFAULT, type GraphMessagesConfig } from './graph.js';
import { type OutboundDocument, OutboundDocumentSchema, OutboundTextSchema } from './index.js';
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
  /**
   * 040: documento (hoje, boleto em PDF). EXIGE janela aberta, como `send` —
   * arquivo livre fora das 24h não existe na Cloud API. Não é limitação nossa:
   * fora da janela só template aprovado passa.
   */
  sendDocument(msg: OutboundDocument, janela: JanelaInfo): Promise<{ waMessageId: string }>;
}

function exigirJanelaAberta(to: string, janela: JanelaInfo): void {
  if (!janela.expiraEm || janela.expiraEm.getTime() < Date.now()) {
    throw new JanelaFechadaError(to);
  }
}

/**
 * Mesmo contrato de `GraphMessagesConfig`: o gateway e o indicador de digitação
 * falam com o MESMO endpoint, com as mesmas credenciais. O alias fica para não
 * quebrar quem já importa o nome.
 */
export type MetaGatewayConfig = GraphMessagesConfig;

/**
 * Mensagem com link: o Cloud API só renderiza a URL como link clicável — com o
 * cartão de preview que o cotista toca — quando `preview_url` vai `true`. Sem
 * ele a URL chega como texto morto: o link de pagamento do 014 aparecia na
 * conversa e não abria nada. Ligar sempre seria pedir preview de qualquer coisa
 * parecida com URL; ligar quando há http(s) é o recorte honesto.
 */
const TEM_URL = /https?:\/\//i;

/** Implementação real: Graph API da Meta (número de teste na POC). */
export function createMetaGateway(config: MetaGatewayConfig): OutboundGateway {
  const fetchFn = config.fetchFn ?? fetch;
  const versao = config.graphVersion ?? GRAPH_VERSAO_DEFAULT;
  const postGraph = criarPostMessages(config);

  const postMessages = async (payload: Record<string, unknown>): Promise<string> => {
    /**
     * A leitura do corpo mora AQUI, e não dentro do post: o corpo do ENVIO traz
     * o wamid, e o do indicador de digitação traz `{success:true}`. Exigir
     * `messages[0].id` no lugar compartilhado faria todo indicador
     * bem-sucedido virar 'Graph API sem message id na resposta'.
     */
    const corpo = (await postGraph(payload)) as { messages?: { id: string }[] };
    const waMessageId = corpo.messages?.[0]?.id;
    if (!waMessageId) throw new Error('Graph API sem message id na resposta');
    return waMessageId;
  };

  /**
   * Upload de mídia: o arquivo vira `media_id` na Meta e só o id viaja na
   * mensagem. É o caminho escolhido pela 040 em vez de link público assinado —
   * o boleto traz nome, CPF e valor, e com upload NENHUMA URL nossa serve esse
   * conteúdo, nem por pouco tempo. O id vale 30 dias lá; aqui é usado em
   * seguida, no mesmo job.
   */
  const uploadMedia = async (d: OutboundDocument): Promise<string> => {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', d.mime);
    // cópia do buffer: `Blob` não aceita view com offset sem levar o buffer inteiro
    form.set('file', new Blob([new Uint8Array(d.bytes)], { type: d.mime }), d.filename);
    const res = await fetchFn(
      `https://graph.facebook.com/${versao}/${config.phoneNumberId}/media`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${config.accessToken}` },
        body: form,
      },
    );
    if (!res.ok) {
      throw new Error(`Graph API media ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const corpo = (await res.json()) as { id?: string };
    if (!corpo.id) throw new Error('Graph API sem media id na resposta');
    return corpo.id;
  };

  return {
    async send(msg, janela) {
      const valida = OutboundTextSchema.parse(msg);
      exigirJanelaAberta(valida.to, janela);
      const waMessageId = await postMessages({
        messaging_product: 'whatsapp',
        to: valida.to,
        type: 'text',
        text: { body: valida.body, preview_url: TEM_URL.test(valida.body) },
      });
      return { waMessageId };
    },
    async sendTemplate(msg) {
      const valida = OutboundTemplateSchema.parse(msg);
      const waMessageId = await postMessages(payloadDeTemplate(valida));
      return { waMessageId };
    },
    async sendDocument(msg, janela) {
      const valida = OutboundDocumentSchema.parse(msg);
      // a janela é checada ANTES do upload: sem ela o envio não vai acontecer,
      // e subir o arquivo para a Meta assim mesmo deixaria o PDF lá à toa
      exigirJanelaAberta(valida.to, janela);
      const mediaId = await uploadMedia(valida);
      const waMessageId = await postMessages({
        messaging_product: 'whatsapp',
        to: valida.to,
        type: 'document',
        document: {
          id: mediaId,
          filename: valida.filename,
          ...(valida.caption ? { caption: valida.caption } : {}),
        },
      });
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
        {
          to: valida.to,
          waMessageId,
          template: valida.nome,
          variaveis: valida.variaveis,
          // 043: o modo log tem que mostrar o botão, senão diverge do real.
          // O `code` do PIX fica de fora de propósito: é instrumento de
          // pagamento e o log estruturado vai para arquivo.
          botao: valida.botao?.tipo ?? null,
          pedido: valida.botao?.orderDetails.referenceId ?? null,
        },
        'template simulado (log-only)',
      );
      return { waMessageId };
    },
    async sendDocument(msg, janela) {
      const valida = OutboundDocumentSchema.parse(msg);
      exigirJanelaAberta(valida.to, janela);
      seq += 1;
      const waMessageId = `sim-doc-${Date.now()}-${seq}`;
      logger.info(
        {
          to: valida.to,
          waMessageId,
          filename: valida.filename,
          mime: valida.mime,
          bytes: valida.bytes.length,
          // os BYTES ficam de fora, sempre: é um boleto com nome, CPF e valor,
          // e o log estruturado vai para arquivo
          caption: valida.caption ?? null,
        },
        'documento simulado (log-only)',
      );
      return { waMessageId };
    },
  };
}
