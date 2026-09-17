/**
 * Fronteiras arquiteturais do monorepo (CLAUDE.md → "Fronteiras").
 * Os padrões de `to` cobrem tanto o path resolvido (packages/x/...) quanto o
 * specifier `@seta/x` (caso o dist ainda não exista e o módulo fique sem resolução).
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'packages-nao-importam-apps',
      comment: 'packages/* não podem depender de apps/*',
      severity: 'error',
      from: { path: '^packages' },
      to: { path: ['^apps', '^@seta/(server|console)'] },
    },
    {
      name: 'agent-nao-importa-erp-connector',
      comment: 'agent só acessa dados via query-catalog, nunca o connector direto',
      severity: 'error',
      from: { path: '^packages/agent' },
      to: { path: ['^packages/erp-connector', '^@seta/erp-connector'] },
    },
    {
      name: 'agent-nao-importa-erp-api',
      comment: 'agent nunca escreve no ERP: escrita é do server, atrás do port ErpWriter',
      severity: 'error',
      from: { path: '^packages/agent' },
      to: { path: ['^packages/erp-api-tse', '^@seta/erp-api-tse'] },
    },
    {
      name: 'cobranca-nao-importa-erp-connector',
      comment:
        'cobranca (014) recebe os títulos já lidos pelo catálogo; nunca fala com o ERP, nem por SQL nem por HTTP',
      severity: 'error',
      from: { path: '^packages/cobranca' },
      to: {
        path: ['^packages/(erp-connector|erp-api-tse)', '^@seta/(erp-connector|erp-api-tse)'],
      },
    },
    {
      name: 'sdr-nao-importa-erp-connector',
      comment:
        'sdr (015) recebe o estoque já lido pelo catálogo; nunca fala com o ERP nem com o catálogo',
      severity: 'error',
      from: { path: '^packages/sdr' },
      to: {
        path: [
          '^packages/(erp-connector|erp-api-tse|query-catalog|agent|guardrails|cobranca)',
          '^@seta/(erp-connector|erp-api-tse|query-catalog|agent|guardrails|cobranca)',
        ],
      },
    },
    {
      name: 'reserva-nao-importa-erp',
      comment:
        'reserva (038) é máquina de estados pura: recebe do server o que já foi lido, e nunca fala com o ERP nem com o catálogo',
      severity: 'error',
      from: { path: '^packages/reserva' },
      to: {
        path: [
          '^packages/(erp-connector|erp-api-tse|query-catalog|agent|guardrails|cobranca)',
          '^@seta/(erp-connector|erp-api-tse|query-catalog|agent|guardrails|cobranca)',
        ],
      },
    },
    {
      name: 'anonimizacao-so-conhece-ai-provider',
      comment:
        'anonimizacao (016) é camada de texto sobre o port AIProvider; nunca vê catálogo, ERP, agent ou guardrails',
      severity: 'error',
      from: { path: '^packages/anonimizacao' },
      to: {
        path: [
          '^packages/(erp-connector|erp-api-tse|query-catalog|agent|guardrails|cobranca|skills|rag|crm|wa-meta|payment-provider)',
          '^@seta/(erp-connector|erp-api-tse|query-catalog|agent|guardrails|cobranca|skills|rag|crm|wa-meta|payment-provider)',
        ],
      },
    },
    {
      name: 'erp-api-e-folha',
      comment:
        'o cliente do TSE é folha: fala HTTP e devolve tipos, e não conhece agente, catálogo nem canal',
      severity: 'error',
      from: { path: '^packages/erp-api-tse' },
      to: {
        path: [
          '^packages/(agent|query-catalog|cobranca|sdr|guardrails|crm|skills|rag|wa-meta)',
          '^@seta/(agent|query-catalog|cobranca|sdr|guardrails|crm|skills|rag|wa-meta)',
        ],
      },
    },
    {
      name: 'so-anonimizacao-usa-transformers',
      comment:
        'a dependência nativa de NER fica atrás do port; ninguém mais importa @huggingface/transformers',
      severity: 'error',
      from: { path: '^(apps|packages)', pathNot: '^packages/anonimizacao' },
      to: { path: '@huggingface/transformers' },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', '/dist/'] },
    exclude: { path: ['\\.(test|spec)\\.tsx?$', '\\.d\\.ts$', '\\.next/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
