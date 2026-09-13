# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=3000 \
    VOIDSTATION_HOST_PROC=/host/proc \
    VOIDSTATION_HOST_ROOT_FS=/host/filesystems/root \
    VOIDSTATION_HOST_DATA_FS=/host/filesystems/data \
    VOIDSTATION_AUTH_DB=/var/lib/voidstation/auth.sqlite
RUN mkdir -p /host/proc /host/filesystems/root /host/filesystems/data /var/lib/voidstation /run/voidstation-tls \
    && touch /host/proc/stat /host/proc/uptime /host/proc/meminfo
# A Next custom server is not traced as a standalone entry point. Keep the
# production dependencies and complete build instead of relying on server.js.
COPY --from=build --chown=1000:1000 /app/package.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/.next ./.next
COPY --from=build --chown=1000:1000 /app/scripts/https-server.mjs /app/scripts/owner.ts ./scripts/
COPY --from=build --chown=1000:1000 /app/src/lib/auth-store.ts ./src/lib/auth-store.ts
USER 1000:1000
EXPOSE 3000
CMD ["node", "scripts/https-server.mjs"]
