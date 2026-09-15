import { z } from 'zod';

/**
 * Botão de template com payload estruturado (043).
 *
 * `order_details` é o fluxo de pagamentos do WhatsApp no Brasil: o botão não
 * carrega texto, carrega um pedido inteiro. Modelamos só o que existe hoje —
 * a união discriminada por `tipo` aceita membros novos (`url`, `quick_reply`)
 * sem refatoração, e um `components` genérico não teria como ser validado.
 *
 * Importa `zod` direto e nunca o barril: `template.ts:3-7` registra o import
 * circular que deixaria o schema `undefined` em tempo de carga.
 *
 * Dinheiro trafega em CENTAVOS em todo o domínio; o `{value, offset}` da Meta
 * é escrito num lugar só, em `payloadDeTemplate` — é a defesa contra o erro de
 * 100×. Mesma disciplina de `centavosParaReais` na borda do PSP.
 */

/** Tipos de chave PIX que a Meta aceita em `pix_dynamic_code.key_type`. */
export const PIX_KEY_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

export const ItemPedidoSchema = z.object({
  /** Id do item no catálogo do vendedor — usamos o id do título. */
  retailerId: z.string().min(1).max(200),
  nome: z.string().min(1).max(60),
  valorCentavos: z.number().int().positive(),
  quantidade: z.number().int().positive().default(1),
});
export type ItemPedido = z.infer<typeof ItemPedidoSchema>;

export const OrderDetailsSchema = z
  .object({
    /** Único por pedido. Sondado em 15/09/2026: a Meta NÃO recusa repetido. */
    referenceId: z.string().min(1).max(200),
    tipo: z.enum(['digital-goods', 'physical-goods']).default('digital-goods'),
    totalCentavos: z.number().int().positive(),
    taxaCentavos: z.number().int().nonnegative().default(0),
    itens: z.array(ItemPedidoSchema).min(1),
    pix: z.object({
      /** Copia-e-cola EMV do PSP. */
      code: z.string().min(1).max(1024),
      merchantName: z.string().min(1).max(60),
      key: z.string().min(1).max(200),
      keyType: z.enum(PIX_KEY_TYPES),
    }),
  })
  // a Meta recusa soma inconsistente com erro opaco (#131009) — falhar aqui,
  // com mensagem que diz o que está errado, é muito mais barato de depurar.
  .superRefine((d, ctx) => {
    const subtotal = d.itens.reduce((s, i) => s + i.valorCentavos * i.quantidade, 0);
    if (subtotal + d.taxaCentavos !== d.totalCentavos) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalCentavos'],
        message: `total (${d.totalCentavos}) deve ser subtotal (${subtotal}) + taxa (${d.taxaCentavos})`,
      });
    }
  });
export type OrderDetails = z.infer<typeof OrderDetailsSchema>;

export const BotaoTemplateSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('order_details'),
    /** Posição do botão no template aprovado. */
    indice: z.number().int().min(0).max(9).default(0),
    orderDetails: OrderDetailsSchema,
  }),
]);
export type BotaoTemplate = z.infer<typeof BotaoTemplateSchema>;

/** Centavos → `{value, offset}` da Meta. O único lugar que escreve `offset`. */
function dinheiro(centavos: number): { value: number; offset: number } {
  return { value: centavos, offset: 100 };
}

/** Componente `components[]` do botão, no formato de fio da Graph API. */
export function componenteDeBotao(botao: BotaoTemplate): Record<string, unknown> {
  const od = botao.orderDetails;
  const subtotal = od.itens.reduce((s, i) => s + i.valorCentavos * i.quantidade, 0);
  return {
    type: 'button',
    sub_type: 'order_details',
    index: botao.indice,
    parameters: [
      {
        type: 'action',
        action: {
          order_details: {
            reference_id: od.referenceId,
            type: od.tipo,
            payment_type: 'br',
            payment_settings: [
              {
                type: 'pix_dynamic_code',
                pix_dynamic_code: {
                  code: od.pix.code,
                  merchant_name: od.pix.merchantName,
                  key: od.pix.key,
                  key_type: od.pix.keyType,
                },
              },
            ],
            currency: 'BRL',
            total_amount: dinheiro(od.totalCentavos),
            order: {
              status: 'pending',
              tax: dinheiro(od.taxaCentavos),
              items: od.itens.map((i) => ({
                retailer_id: i.retailerId,
                name: i.nome,
                amount: dinheiro(i.valorCentavos),
                quantity: i.quantidade,
              })),
              subtotal: dinheiro(subtotal),
            },
          },
        },
      },
    ],
  };
}
