# Builds the API, worker and web bundles once; the api/worker/web images share the stages.
FROM node:22.22.0-bookworm-slim AS base
ARG EXTRA_CA_DIR=infra/certs
# Optional extra CA certificates for intercepting proxies (see infra/certs/README.md); no apt needed.
COPY ${EXTRA_CA_DIR}/ /usr/local/share/ca-certificates/extra/
COPY infra/docker/with-ca.sh /usr/local/bin/with-ca
RUN chmod +x /usr/local/bin/with-ca \
  && (cat /usr/local/share/ca-certificates/extra/*.crt > /usr/local/share/ca-certificates/extra-bundle.crt 2>/dev/null || true) \
  && with-ca corepack enable && with-ca corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN with-ca pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NX_DAEMON=false NX_NO_CLOUD=true
RUN with-ca pnpm prisma generate \
  && with-ca pnpm nx run-many -t build -p api worker web --configuration=production --skip-nx-cache

# Production dependencies only (the prisma CLI is a runtime dependency for migrations).
FROM deps AS prod-deps
RUN with-ca pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/api ./dist/apps/api
COPY --from=build /app/dist/apps/worker ./dist/apps/worker
COPY --from=build /app/libs/server/src/persistence/generated ./libs/server/src/persistence/generated
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY whatsapp ./whatsapp
COPY infra/docker/entrypoint.sh /usr/local/bin/raaye-entrypoint
RUN chmod +x /usr/local/bin/raaye-entrypoint
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=30 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["raaye-entrypoint"]
CMD ["api"]

FROM nginx:1.29-alpine AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/apps/web/browser /usr/share/nginx/html
EXPOSE 8080
