/**
 * Rotas da coleção que o simulador AINDA não responde (035, 038). A lista é
 * explícita de propósito: é o placar do dublê, e `contrato.test.ts` garante
 * que ela só encolhe — uma rota implementada some daqui, e nenhuma fixture
 * pode ficar fora das duas listas.
 *
 * Quase tudo aqui tem dono marcado: a 2ª via em PDF é da 040. O ciclo
 * comercial (lead, pessoa e venda) saiu daqui na 045.
 * `OperadorSistema/*` e `Relatorios/*` (30 rotas) estão fora de escopo da frente
 * inteira — nenhuma jornada da demo as usa.
 *
 * Duas exceções conscientes da 038, sem consumidor na jornada:
 * `PainelDoCliente/SimularUtilizacaoContrato` (a simulação que a 038 usa é a do
 * OPERADOR, que é a única que devolve `Bloqueado` por diária) e as taxas/pensão
 * de utilização (`AdicionarTaxaManutencao`, `AdicionarTipoPensao`,
 * `ObterTotalReceberPorTipo`) — a taxa da reserva já sai de `CriarUtilizacaoContrato`.
 */
export const PENDENTES: readonly string[] = [
  // Client Area (2)
  'client-area__second-ticket',
  'client-area__simulate-contract-usage',
  // System Operator (20)
  'system-operator__active-or-inactive-operator',
  'system-operator__assign-permissions-group',
  'system-operator__change-business-unit',
  'system-operator__change-company',
  'system-operator__change-password',
  'system-operator__change-user',
  'system-operator__create-new-system-operator',
  'system-operator__get-all-groups-with-users',
  'system-operator__get-all-peoples-related-employes',
  'system-operator__get-all-permissions-with-groups-of-users',
  'system-operator__get-all-users',
  'system-operator__get-all-users-related-groups',
  'system-operator__get-system-operator-by-id',
  'system-operator__get-user-group-by-id',
  'system-operator__getting-operatory-by-login',
  'system-operator__getting-permissions-groups',
  'system-operator__grant-access-to-companies',
  'system-operator__remove-groups-permissions-of-operator',
  'system-operator__reset-password',
  'system-operator__revoke-access-to-companies',
  // Contract Usase (15)
  'contract-usase__add-guest',
  'contract-usase__add-instalments',
  'contract-usase__add-meal-type',
  'contract-usase__create-cancellation-fee',
  'contract-usase__get-block-code',
  'contract-usase__get-company',
  'contract-usase__get-market-code',
  'contract-usase__getting-contract-usage-of-fractionation-credit',
  'contract-usase__getting-credit-card-brands',
  'contract-usase__getting-installments-types',
  'contract-usase__getting-interchange-contracts',
  'contract-usase__getting-payment-types',
  'contract-usase__getting-total-receivable-by-contract-usage-id',
  'contract-usase__perform-instalments-payment',
  'contract-usase__remove-guest',
  // Reports (3)
  'reports__get-data-json-report',
  'reports__get-data-json-report-whit-parameters',
  'reports__get-data-zip-report',
];
