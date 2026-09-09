# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    VOIDSTATION_HOST_PROC=/host/proc \
    VOIDSTATION_HOST_ROOT_FS=/host/filesystems/root \
    VOIDSTATION_HOST_DATA_FS=/host/filesystems/data
RUN mkdir -p /host/proc /host/filesystems/root /host/filesystems/data && touch /host/proc/stat /host/proc/uptime /host/proc/meminfo
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
