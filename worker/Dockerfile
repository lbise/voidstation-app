FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.13.1-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY media ./media
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /app/media/requirements.txt \
  && chmod -R a-w /app/media
# The deterministic model adapter is unavailable in the runtime image.
RUN rm -f dist/test-fixture.js dist/test-fixture.d.ts dist/test-fixture.js.map \
  && mkdir -p /var/lib/voidstation/conversations /var/lib/voidstation/credentials /tmp \
  && chown -R node:node /app /var/lib/voidstation /tmp
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
