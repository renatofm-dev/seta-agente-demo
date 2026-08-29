# syntax=docker/dockerfile:1
# Imagem do console (011): Next standalone. Contexto = raiz do monorepo.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# rewrites do Next são resolvidos NO BUILD — aqui o proxy /api aponta para o
# service `server` do compose.prod (em dev continua localhost:3001)
ENV SERVER_INTERNAL_URL=http://server:3001
RUN pnpm --filter @seta/console build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# layout standalone de monorepo: server.js fica sob apps/console/
COPY --from=build /app/apps/console/.next/standalone ./
COPY --from=build /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=build /app/apps/console/public ./apps/console/public

EXPOSE 3000
CMD ["node", "apps/console/server.js"]
