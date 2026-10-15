import { z } from 'zod';
import type { LogGatewayLogger } from './gateway.js';
import { criarPostMessages, type GraphMessagesConfig } from './graph.js';

/**
 * "Digitando…" no WhatsApp, antes de o agente responder.
 *
 * Port PRÓPRIO, e não um 4º método do `OutboundGateway`, porque o único código
 * autorizado a chamar o gateway é o worker do outbox: toda resposta do agente
 * passa pela tabela `outbox` (dedupe por `turnoId:seq`, retry do pg-boss, janela
 * de 24 h, reengajamento por template). Quem mostra o indicador é o turno-handler,
 * e ele não pode ganhar de brinde a capacidade de enviar mensagem direto — é o
 * fato de não ter o gateway na mão que sustenta essa invariante hoje.
 *
 * O verbo também é outro: `send` é "mandar mensagem para um número, respeitando a
 * janela" e devolve um wamid; `mostrar` é "reagir a uma mensagem recebida", sem
 * janela, sem destinatário e sem id de volta.
 *
 * O contrato da Meta é um POST no MESMO `/messages`, com `status: 'read'` e
 * `typing_indicator`. Consequências que não são escolha nossa:
 *  - marca a mensagem como LIDA (dois tiques azuis). Não existe indicador sem
 *    leitura: é um request só;
 *  - exige o `message_id` (wamid) de uma mensagem RECEBIDA — por isso disparo
 *    proativo (campanha, aviso de pagamento) não tem indicador;
 *  - dura no máximo 25 s, ou até a resposta sair, o que vier primeiro;
 *  - a resposta é `{ success: true }`, SEM `messages[0].id`.
 */

/** Quem sabe mostrar "digitando…" para quem mandou `waMessageId`. */
export interface IndicadorDigitacao {
  /**
   * Rejeita em falha de rede ou erro da Graph API: a política de "engolir e
   * logar" é do chamador, num ponto só, e não de cada adapter — adapter que
   * esconde falha é adapter que não se consegue testar no modo falha.
   *
   * `signal` existe para o chamador CANCELAR um disparo em vôo quando a resposta
   * já saiu: se o request pousar na Meta depois do envio, não há mais nada para
   * apagar o indicador, e o contato veria "digitando" por 25 s com a mensagem já
   * entregue. Abortar não desfaz um request que a Meta já recebeu, mas cobre
   * DNS, TCP, TLS e trânsito — a maior parte da latência.
   */
  mostrar(waMessageId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * 3 s. Socket pendurado não pode virar request aberta pelo resto do turno —
 * mesmo raciocínio do resumo rolante (#27) e do classificador de intenção.
 */
export const TIMEOUT_INDICADOR_MS = 3_000;

const WaMessageIdSchema = z.string().min(1).max(256);

/**
 * Só o formato que a Meta emite. O simulador dev injeta id sintético (`sim-…`,
 * `dev-routes.ts`) NO MESMO PROCESSO que fala com o número real quando se roda
 * `pnpm dev-whatsapp` — mandar isso para a Graph API é 400 garantido e um `warn`
 * por turno em cima de um caminho que está correto.
 */
export function ehWamidDaMeta(waMessageId: string): boolean {
  return waMessageId.startsWith('wamid.');
}

/** Implementação real: Graph API da Meta. */
export function createMetaIndicador(config: GraphMessagesConfig): IndicadorDigitacao {
  const post = criarPostMessages(config, { timeoutMs: TIMEOUT_INDICADOR_MS });
  return {
    async mostrar(waMessageId, signal) {
      const id = WaMessageIdSchema.parse(waMessageId);
      if (!ehWamidDaMeta(id)) return; // id do simulador: não existe lá para reagir
      // a resposta é `{success:true}`; o corpo é IGNORADO de propósito
      await post(
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: id,
          typing_indicator: { type: 'text' },
        },
        signal,
      );
    },
  };
}

/**
 * Dev/simulador: não fala com a Meta, só loga — mas valida o MESMO wamid que o
 * real validaria, para o comportamento não divergir (igual `createLogGateway`).
 */
export function createLogIndicador(logger: LogGatewayLogger): IndicadorDigitacao {
  return {
    async mostrar(waMessageId) {
      const id = WaMessageIdSchema.parse(waMessageId);
      logger.info({ waMessageId: id }, 'indicador de digitação simulado (log-only)');
    },
  };
}
