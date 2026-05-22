# syntax=docker/dockerfile:1.7
# =============================================================================
# Dockerfile — multi-stage build for PowerDNS-AuthAdmin
#
# Stages:
#   builder   — install full deps + Next build → standalone output.
#   deps      — fresh `npm ci --omit=dev --include=optional` against the
#               same lockfile. Produces a prod-only node_modules tree the
#               runner copies wholesale.
#   runner    — Debian/glibc Node 22 (bookworm-slim), non-root, production
#               image. Boots via a small entrypoint that runs DB migrations
#               (ADR-0011), then first-boot provisioning (ADR-0012), then
#               launches Next.js. The boot scripts are TypeScript sources
#               executed by `tsx` (shipped as a runtime dep) — no compile
#               step in the image; tsx reads the existing tsconfig + source
#               and transpiles on the fly.
#
# Critical: all stages use Debian/glibc base images, NOT alpine/musl.
#   Reason: napi-rs native bindings (@node-rs/argon2, @tailwindcss/oxide,
#   better-sqlite3) resolve to different prebuilt binaries by libc. A builder
#   on musl would install musl binaries that can't be loaded by a glibc
#   runner — produces a runtime `Failed to load native binding` error. Keep
#   libcs aligned.
#
# Why bookworm-slim runner (not distroless):
#   The boot-time migration + provisioning steps need `lib/db/index.ts`,
#   `drizzle-orm`, the dialect driver (`pg` / `better-sqlite3`), `js-yaml`,
#   and `tsx` on disk at runtime. Those aren't traced into Next.js'
#   standalone bundle (they're imported from `scripts/*.ts`, not from app
#   routes). A shell + the prod node_modules tree is the simplest way to
#   make boot work without an elaborate bundling step.
#
# Why scripts ARE allowed during install: better-sqlite3 ships its native
# binary via `prebuild-install`, which runs as a postinstall step. Disabling
# scripts skips that download → the SQLite path fails at runtime with a
# missing-binding error. The trust trade-off here is real but bounded:
# every dep that runs a postinstall is reviewed in the lockfile.
# =============================================================================

# --- Stage 1: builder --------------------------------------------------------
FROM node:24-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --include=optional; \
    else \
      echo "[builder] package-lock.json missing — falling back to npm install. Commit the generated lockfile to lock future builds."; \
      npm install --include=optional --no-audit --no-fund; \
    fi

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build


# --- Stage 2: prod deps tree -------------------------------------------------
# Separate stage so the runner gets a clean `npm ci --omit=dev` tree without
# the devDeps that the builder needed (drizzle-kit, tsc, vitest, prettier).
FROM node:24-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --include=optional


# --- Stage 3: runner --------------------------------------------------------
FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user for the app. `node:bookworm-slim` ships a `node` user with
# uid 1000 — reuse it instead of creating our own. /data is the conventional
# mount target for the SQLite file (DATABASE_URL=file:/data/...).
RUN mkdir -p /data && chown -R node:node /app /data

# Next.js standalone bundle + static assets.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Boot-time TypeScript sources (executed by tsx, see entrypoint.mjs).
# Includes scripts/migrate.ts + scripts/provision.ts and the lib/ tree they
# import. tsconfig.json is required at runtime so tsx resolves the `@/*`
# path alias the way the rest of the codebase does.
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/drizzle-sqlite ./drizzle-sqlite

# Prod-only node_modules from the deps stage. The standalone bundle has
# its own ./node_modules with the traced subset for Next.js; this overlay
# brings in the rest the boot scripts need. Drizzle's resolution finds
# whichever copy comes first in the path; both copies are the same exact
# versions so the duplication is structurally safe.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Entrypoint: migrate → provision → server. `node` directly — no shell —
# so signals (SIGTERM from k8s/compose) reach the Node process cleanly.
COPY --from=builder --chown=node:node /app/docker/entrypoint.mjs ./entrypoint.mjs

USER node

EXPOSE 3000

CMD ["node", "entrypoint.mjs"]
