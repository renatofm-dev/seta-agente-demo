import type { NextConfig } from 'next';

const SERVER_URL = process.env.SERVER_INTERNAL_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  // regras de agente vivem no CLAUDE.md da raiz do monorepo
  agentRules: false,
  // proxy → server (same-origin: cookies de sessão e SSE sem CORS)
  async rewrites() {
    return [
      { source: '/api-dev/:path*', destination: `${SERVER_URL}/:path*` },
      { source: '/api/:path*', destination: `${SERVER_URL}/api/:path*` },
    ];
  },
};

export default nextConfig;
