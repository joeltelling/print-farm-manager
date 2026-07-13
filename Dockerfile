# syntax=docker/dockerfile:1

# ---- Stage 1: server dependencies -----------------------------------------
# Installed with devDependencies so the `postinstall` (patch-package) step can
# apply patches/sdcp+0.5.4.patch to node_modules/sdcp, and so the `dev` stage
# below (which needs jest/supertest/vite etc.) can reuse this layer instead of
# repeating the apt-get/npm ci work.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

# Pruned to production deps only — used by the `runtime` stage so jest/supertest/
# patch-package don't ship, while the patched files `npm ci` produced still do.
FROM deps AS server-deps
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

# ---- Stage 4: development -------------------------------------------------
# Not used for production — this backs the `dev`-profile service in
# docker-compose.yml, run on its own via
# `docker compose up --build print-farm-manager-dev` (name the service
# explicitly so it doesn't start alongside production — see that file's
# comment on this service for why `--profile dev` alone isn't enough). Full
# source is bind-mounted at runtime, not baked in here; this stage only
# provides dependencies (including devDependencies and client/node_modules) so
# the container starts without a local npm install and without the
# native-module (better-sqlite3) ABI mismatches that come from bind-mounting a
# macOS/Windows host's own node_modules into a Linux container. See
# docker-compose.yml's `dev` service for how node_modules is kept out of that
# bind mount.
FROM deps AS dev
WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client

EXPOSE 3000 5173

# server/index.js requires client/dist/index.html to exist (regardless of dev
# vs. production) even though nothing in the dev workflow actually serves from
# it — the browser talks to Vite on :5173, which proxies /api to :3000. Build
# once on first start if it's missing (e.g. a fresh clone bind-mounted in with
# no prior `npm run build`) so the container is usable without that manual
# step; skip it on subsequent starts since client/dist persists on the host
# via the bind mount. `&&`, not `;` — a broken build must stop here loudly
# instead of silently falling through into `npm run dev` with the server half
# of it doomed to crash on the same missing-dist check for a non-obvious reason.
CMD ["sh", "-c", "npm run dev"]
