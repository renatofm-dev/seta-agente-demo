import type { NextConfig } from 'next';

const SERVER_URL = process.env.SERVER_INTERNAL_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  // regras de agente vivem no CLAUDE.md da raiz do monorepo
  agentRules: false,
  // proxy dev → server (evita CORS no simulador)
  async rewrites() {
    return [{ source: '/api-dev/:path*', destination: `${SERVER_URL}/:path*` }];
  },
};

export default nextConfig;
