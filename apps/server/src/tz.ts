/**
 * Dia "de negócio" do cliente (#37): buckets de métricas, competência das
 * campanhas e datas dos relatórios são calculados neste fuso, não em UTC.
 * POC de 1 cliente; multi-fuso fica para o produto.
 */
export const TZ_CLIENTE = 'America/Sao_Paulo';
