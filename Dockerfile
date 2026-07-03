# syntax=docker/dockerfile:1

# ---- Stage 1: server dependencies -----------------------------------------
# Installed with devDependencies so the `postinstall` (patch-package) step can
# apply patches/sdcp+0.5.4.patch to node_modules/sdcp. Pruned to production
# deps afterward so the patched files ship but jest/supertest/patch-package don't.
FROM node:22-bookworm-slim AS server-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci
RUN npm prune --omit=dev

# ---- Stage 2: build the React client ---------------------------------------
FROM node:22-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 3: production runtime -------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY --from=server-deps /app/node_modules ./node_modules
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist

# Persistent state — mount volumes here in production (see docker-compose.yml)
RUN mkdir -p server/data server/gcode

EXPOSE 3000

CMD ["node", "server/index.js"]
