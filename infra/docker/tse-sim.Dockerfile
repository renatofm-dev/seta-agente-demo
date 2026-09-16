# syntax=docker/dockerfile:1
# Imagem do simulador da API do TS Explorer (035). Contexto de build = raiz do
# monorepo, no molde do server.Dockerfile.
#
# O serviço NÃO publica porta e o Caddy não tem rota para ele: o simulador só
# existe na rede interna do compose, alcançável em http://tse-sim:3010 pelo
# server. Um dublê do ERP exposto à internet seria um convite.

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

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY --from=build /app/packages ./packages
# leva o `contrato/` junto do `dist/`: as rotas Lookup/* são servidas DIRETO das
# fixtures, então o contrato extraído da coleção é dado de RUNTIME, não de build
COPY --from=build /app/apps/tse-sim ./apps/tse-sim
RUN pnpm install --frozen-lockfile --prod --filter @seta/tse-sim...

EXPOSE 3010
CMD ["node", "apps/tse-sim/dist/index.js"]
