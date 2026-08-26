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
