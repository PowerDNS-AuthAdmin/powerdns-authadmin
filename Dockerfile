# syntax=docker/dockerfile:1.7
# =============================================================================
# Dockerfile — multi-stage build for PowerDNS-AuthAdmin
#
# Stages:
#   builder  — full deps install, Next.js production build, AND pre-bundle
#              of the three boot-time TS scripts into self-contained ESM
#              files. Three artefacts feed the runner:
#                1. `.next/standalone` — Next's traced server bundle
#                   (incl. the runtime node_modules subset Next computed).
#                2. `.next/static` + `public` — static assets.
#                3. `boot/{migrate,seed,provision}.js` — esbuild-bundled
#                   ESM versions of the .ts scripts, every `lib/*` import
#                   inlined.
#
#   fs-prep — bookworm-slim layout-and-strip stage. Distroless has no
#             shell, no apt, no `mkdir`, no `strip`. So we assemble the
#             final filesystem here (chown, strip native .node binaries
#             to drop debug symbols, prepare /data) and COPY the prepared
#             tree as a single layer into the distroless runner.
#
#   runner  — `gcr.io/distroless/nodejs24-debian12:nonroot`. Non-root by
#             default (uid 65532 `nonroot`). NO shell, NO package manager,
#             NO source tree, NO tsx, NO separate prod-deps node_modules.
#             Boot bundles run with `node` directly. Externals (native
#             bindings, pg, pino transports) resolve from the standalone
#             bundle's already-traced node_modules.
#
# Critical: builder + fs-prep use Debian/glibc (NOT alpine/musl). napi-rs
# native bindings (@node-rs/argon2, better-sqlite3) resolve to different
# prebuilt binaries by libc; a builder on musl would install musl
# binaries that can't be dlopen()'d by the glibc runner. Both bases
# share the same glibc to keep the bindings portable.
#
# Trade-off (vs. bookworm-slim runner): no shell at runtime — incident
# triage via `docker exec <id> sh` is unavailable. If you need it, build
# a separate `:debug` tag against bookworm-slim using the same builder.
# =============================================================================

# --- Stage 1: builder --------------------------------------------------------
FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

# `npm ci` only — it installs strictly from the committed lockfile, so the
# build is reproducible and every dependency version is hash-pinned via
# package-lock.json. No `npm install` fallback: the lockfile is committed,
# and an image that silently un-pinned-installs on a missing lock would be
# a supply-chain regression (OpenSSF Scorecard "Pinned-Dependencies").
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=optional

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Two outputs from the same source tree:
#   • npm run build       → .next/standalone (Next.js production server)
#   • npm run build:boot  → boot/{migrate,seed,provision}.js (esbuild)
RUN npm run build && npm run build:boot


# --- Stage 2: fs-prep --------------------------------------------------------
# Distroless has no shell to run mkdir / chown / strip. We assemble the final
# tree here under bookworm-slim where we DO have those tools.
FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS fs-prep

WORKDIR /stage

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/boot ./boot
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle-sqlite ./drizzle-sqlite
COPY --from=builder /app/docker/entrypoint.mjs ./entrypoint.mjs

# Strip debug symbols from every .node native binding we ship
# (better-sqlite3, @node-rs/argon2). Sub-MB each but free; the stripped
# binaries dlopen identically. binutils is purged before COPY so none of
# it lands in the distroless runner.
RUN apt-get update && apt-get install -y --no-install-recommends binutils \
    && find . -name '*.node' -exec strip --strip-unneeded {} \; \
    && apt-get purge -y binutils \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Distroless `nonroot`: uid 65532, gid 65532.
RUN chown -R 65532:65532 /stage && \
    mkdir -p /data-stage && chown -R 65532:65532 /data-stage


# --- Stage 3: runner (distroless) -------------------------------------------
# Digest-pinned like the builder/fs-prep stages above (supply-chain
# reproducibility; OpenSSF Scorecard "Pinned-Dependencies"). This is the
# multi-arch index digest for :nonroot — bump it alongside the base-image
# refresh that updates the node:24-bookworm-slim digests.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Distroless puts `node` at /nodejs/bin/node and runs it as the image's
# ENTRYPOINT, but does NOT add /nodejs/bin to $PATH. Compose health-
# checks of the form `CMD ["node", ...]` bypass ENTRYPOINT and exec
# `node` directly from PATH — they need it visible there.
ENV PATH=/nodejs/bin:$PATH

# Build provenance surfaced in the UI (sidebar version chip + GitHub/Docs
# links, see lib/app-meta.ts). The CI docker job sets GIT_SHA to the
# commit and APP_RELEASE=true only for vX.Y.Z tag builds. Both default
# empty for a plain `docker build`, which makes the app fall back to
# release/tag links.
ARG GIT_SHA=""
ARG APP_RELEASE="false"
ENV APP_GIT_SHA=$GIT_SHA
ENV APP_RELEASE=$APP_RELEASE

WORKDIR /app

COPY --from=fs-prep --chown=nonroot:nonroot /stage/ /app/
COPY --from=fs-prep --chown=nonroot:nonroot /data-stage /data

USER nonroot

EXPOSE 3000

# Distroless/nodejs ships with `node` as the entrypoint; the CMD is the
# script path. Same effect as `node entrypoint.mjs` on bookworm-slim.
CMD ["entrypoint.mjs"]
