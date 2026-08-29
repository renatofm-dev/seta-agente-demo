# syntax=docker/dockerfile:1
# Imagem do server (011). Contexto de build = raiz do monorepo.
# Build SEMPRE no CI (GHCR) — a CX23 (4 GB) não builda Next/TS com folga.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# manifests + workspaces compilados; install prod só do server e suas deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
RUN pnpm install --frozen-lockfile --prod --filter @seta/server...

# assets de runtime (env paths apontam para cá — absolutos no compose)
COPY catalog ./catalog
COPY configs ./configs
COPY kb ./kb
COPY skills-seed ./skills-seed
# seed do erp_mock roda DENTRO de apps/server: resolução ESM de pg/@seta via
# node_modules do server (o seed lê os .sql do próprio diretório)
COPY infra/erp-mock ./apps/server/erp-mock
COPY infra/docker/demo-seed.sh ./demo-seed.sh

EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
