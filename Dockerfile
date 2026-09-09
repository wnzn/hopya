# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS toolchain
WORKDIR /app
# Native SQLite dependencies may need compilation when no prebuild is available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
ENV ASTRO_TELEMETRY_DISABLED=1

FROM toolchain AS build
RUN npm ci --no-audit --no-fund
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN npm run build

FROM toolchain AS production-dependencies
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1
COPY --from=production-dependencies /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
# Keep workspace-local dependencies and npm's workspace symlink targets intact.
COPY --from=production-dependencies /app/apps ./apps
USER node

FROM runtime AS api
USER root
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
COPY --from=build /app/apps/api/build ./apps/api/build
ENV HOST=0.0.0.0 API_PORT=3333 DATA_DIR=/data
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3333/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "--workspace=@hopya/api"]

FROM runtime AS web
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV HOST=0.0.0.0 PORT=4321
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4321/login',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/dist/server/entry.mjs"]
