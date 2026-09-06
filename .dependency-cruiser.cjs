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
      name: 'cobranca-nao-importa-erp-connector',
      comment: 'cobranca (014) recebe os títulos já lidos pelo catálogo; nunca fala com o ERP',
      severity: 'error',
      from: { path: '^packages/cobranca' },
      to: { path: ['^packages/erp-connector', '^@seta/erp-connector'] },
    },
    {
      name: 'anonimizacao-so-conhece-ai-provider',
      comment:
        'anonimizacao (016) é camada de texto sobre o port AIProvider; nunca vê catálogo, ERP, agent ou guardrails',
      severity: 'error',
      from: { path: '^packages/anonimizacao' },
      to: {
        path: [
          '^packages/(erp-connector|query-catalog|agent|guardrails|cobranca|skills|rag|crm|wa-meta|payment-provider)',
          '^@seta/(erp-connector|query-catalog|agent|guardrails|cobranca|skills|rag|crm|wa-meta|payment-provider)',
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
