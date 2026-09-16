/**
 * Rotas da coleção que o simulador AINDA não responde (035). A lista é
 * explícita de propósito: é o placar do dublê, e `contrato.test.ts` garante
 * que ela só encolhe — uma rota implementada some daqui, e nenhuma fixture
 * pode ficar fora das duas listas.
 *
 * Quase tudo aqui tem dono marcado: reserva e hóspedes na 038, lead e venda na
 * 039, 2ª via em PDF na 040. `OperadorSistema/*` e `Relatorios/*` (30 rotas)
 * estão fora de escopo da frente inteira — nenhuma jornada da demo as usa.
 */
export const PENDENTES: readonly string[] = [
  // Client Area (6)
  'client-area__create-contract-usage-request',
  'client-area__hotel-unit-types',
  'client-area__hotels-available-for-use',
  'client-area__my-contract-usages',
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
  // Contract Usase (25)
  'contract-usase__add-guest',
  'contract-usase__add-instalments',
  'contract-usase__add-meal-type',
  'contract-usase__cancel-contract-usage',
  'contract-usase__confirm-contract-usage',
  'contract-usase__create-cancellation-fee',
  'contract-usase__create-contract-usage',
  'contract-usase__get-block-code',
  'contract-usase__get-company',
  'contract-usase__get-market-code',
  'contract-usase__getting-age-group-types',
  'contract-usase__getting-contract-usage-information',
  'contract-usase__getting-contract-usage-of-fractionation-credit',
  'contract-usase__getting-credit-card-brands',
  'contract-usase__getting-guests',
  'contract-usase__getting-hotel-unit-types',
  'contract-usase__getting-hotels',
  'contract-usase__getting-installments-types',
  'contract-usase__getting-interchange-contracts',
  'contract-usase__getting-meal-types',
  'contract-usase__getting-payment-types',
  'contract-usase__getting-total-receivable-by-contract-usage-id',
  'contract-usase__perform-instalments-payment',
  'contract-usase__remove-guest',
  'contract-usase__simulate-contract-usage',
  // Aproach Control (3)
  'aproach-control__create-lead',
  'aproach-control__getting-lead',
  'aproach-control__getting-leads-by-period',
  // General Registers (1)
  'general-registers__create-person',
  // Sales (1)
  'sales__create-new-sale',
  // Reports (3)
  'reports__get-data-json-report',
  'reports__get-data-json-report-whit-parameters',
  'reports__get-data-zip-report',
];
