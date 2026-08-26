import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // regras de agente vivem no CLAUDE.md da raiz do monorepo
  agentRules: false,
};

export default nextConfig;
