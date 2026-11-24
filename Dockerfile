# syntax=docker/dockerfile:1
# Uivo: API + agendador + painel em uma imagem enxuta, sem root.
# SQLite nativo do Node (node:sqlite): nenhuma dependência compilada, então amd64 e arm64 saem iguais.

ARG NODE_IMAGE=node:24-bookworm-slim

# ─── Dependências completas (build do painel) ─────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ─── Build do painel (Vite) ───────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npm run build

# ─── Só dependências de produção ──────────────────────────────────────────────
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ─── Imagem final ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Uivo" \
      org.opencontainers.image.description="Monitor de saúde de sites: disponibilidade, SSL e vencimento de domínio" \
      org.opencontainers.image.source="https://github.com/gusmcardoso/uivo" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist/web ./dist/web
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.ts"]
