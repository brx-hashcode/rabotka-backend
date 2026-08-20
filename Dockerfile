# Both stages use Debian slim — single base image, no Alpine/apk DNS issues
#
# `deps` exists so the fastembed stage below can branch off the dependency
# layers WITHOUT depending on the source tree. Rooting it at `builder` instead
# would re-download ~2.7GB of ONNX weights on every source change, because
# `COPY . .` invalidates everything after it.
FROM node:22-slim AS deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm

COPY package.json pnpm-lock.yaml .npmrc ./

# --ignore-scripts skips postinstall (prisma generate) which crashes due to
# a transitive ESM/CJS conflict in @prisma/dev bundled with prisma@7.x.
# Note it also skips puppeteer's own postinstall, so no Chromium is downloaded
# here — the final stage installs Debian's chromium instead (see below).
# PUPPETEER_SKIP_DOWNLOAD makes that explicit, so dropping --ignore-scripts
# later can't silently start bundling a second ~400MB browser.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Rebuild native addons skipped by --ignore-scripts
RUN pnpm rebuild sharp better-sqlite3

FROM deps AS builder

# Copy prisma schema before generating client
COPY prisma ./prisma/

# Generate Prisma client explicitly
RUN pnpm exec prisma generate

COPY . .

RUN pnpm run build

# ─── fastembed target — the ONNX weights, baked ───────────────────────────────
#
# These used to be downloaded at container start into a named volume. That cost
# a production incident: the volume outlived the image, `useradd -r` handed the
# runtime user a different uid on a later build, and the first WhatsApp message
# to need the model hit EACCES mid-download — inside the reply budget, in the
# process serving HTTP.
#
# Baking them removes the volume, the uid coupling, the start-up race between
# api and queue-worker, and the lazy download itself. A layer is content-
# addressed, so the registry verifies it: the truncated-tarball failure mode
# cannot survive a pull.
#
# Rooted at `deps`, so this ~2.7GB layer is rebuilt only when the lockfile
# changes — not on every commit.
FROM deps AS fastembed

ENV FASTEMBED_CACHE_DIR=/opt/fastembed

# `fastembed` resolves a model by looking for its files on disk and downloading
# only what is missing, so this is the same code path the app would take — just
# at build time, where a failure stops the release instead of a conversation.
RUN mkdir -p /opt/fastembed && node -e " \
    const { FlagEmbedding, EmbeddingModel, SparseTextEmbedding, SparseEmbeddingModel } = require('fastembed'); \
    const cacheDir = process.env.FASTEMBED_CACHE_DIR; \
    (async () => { \
      await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir }); \
      await SparseTextEmbedding.init({ model: SparseEmbeddingModel.SpladePPEnV1, cacheDir }); \
      await FlagEmbedding.init({ model: EmbeddingModel.MLE5Large, cacheDir }); \
    })().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); \
  "

# Fail the BUILD on a partial download rather than shipping one. fastembed's
# own `downloadFileFromGCS` returns early when the archive path merely exists,
# with no size or checksum check, so an interrupted fetch is otherwise
# indistinguishable from a complete one — for the lifetime of the image.
RUN set -eu; \
    for model in fast-bge-small-en-v1.5 prithivida_Splade_PP_en_v1 fast-multilingual-e5-large; do \
      test -f "/opt/fastembed/$model/tokenizer.json" || { echo "FATAL: $model has no tokenizer.json"; exit 1; }; \
      test -f "/opt/fastembed/$model/config.json"    || { echo "FATAL: $model has no config.json"; exit 1; }; \
    done; \
    test -f /opt/fastembed/fast-multilingual-e5-large/model.onnx_data \
      || { echo "FATAL: e5-large weights missing"; exit 1; }; \
    test -z "$(find /opt/fastembed -name '*.tar.gz' -print -quit)" \
      || { echo "FATAL: an undeleted archive means extraction did not finish"; exit 1; }; \
    du -sh /opt/fastembed

# ─── api target — slim, no LibreOffice ────────────────────────────────────────
FROM node:22-slim AS api

WORKDIR /app

# chromium is what puppeteer drives to render the CV PDF (resume.service) and
# as the docx->pdf fallback (document.service). Installing Debian's package
# pulls in every shared library Chromium needs, which is why it is preferred
# over downloading a browser and hand-listing libnss3/libgbm1/etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        postgresql-client \
        chromium \
        libreoffice-writer \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-noto-core \
        fontconfig && \
    fc-cache -f && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm && \
    groupadd -r -g 10001 nestjs && \
    useradd -r -u 10001 -g nestjs nestjs && \
    mkdir -p /home/nestjs/.local/share/pnpm

COPY package.json pnpm-lock.yaml tsconfig.json nest-cli.json prisma.config.ts ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/assets ./assets
# Maintenance scripts (pnpm portfolio:backfill-slugs, …).
#
# NOTE: 16 of these import from `../src/...`, which is NOT copied into this
# image, so those aliases fail here with MODULE_NOT_FOUND however they are
# invoked — `wa:test-reminders` and the vova CLIs among them. Anything that has
# to run in production belongs in `dist` as its own entry point; see
# `dist/src/modules/rag/retrieval/ingest.cli.js`.
COPY --from=builder /app/scripts ./scripts

# The embedders, from the stage that verified them. Chowned on copy so the
# files are owned by the pinned uid without a second full-size layer.
COPY --from=fastembed --chown=nestjs:nestjs /opt/fastembed /opt/fastembed

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# The corpus reaches `dist` through a nest-cli asset rule, not through tsc, so
# nothing in the build fails if that rule is dropped or if .dockerignore starts
# matching `**/*.md` — the assistant would simply answer from nothing. Assert it.
RUN test "$(find dist/src/modules/rag/retrieval/corpus -name '*.md' | wc -l)" -gt 15 \
    || { echo "FATAL: help corpus missing from dist"; exit 1; }

ENV NODE_ENV=production \
    CI=true \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=2048" \
    PNPM_HOME="/home/nestjs/.local/share/pnpm" \
    HOME=/tmp \
    SAL_USE_VCLPLUGIN=svp \
    DISPLAY="" \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    FASTEMBED_CACHE_DIR=/opt/fastembed

RUN chown -R nestjs:nestjs /app /home/nestjs

USER nestjs

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/src/main"]

# ─── worker target — includes LibreOffice for PDF generation ──────────────────
FROM node:22-bookworm-slim AS worker

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        postgresql-client \
        libreoffice-writer \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-noto-core \
        fontconfig && \
    fc-cache -f && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm

# LibreOffice needs a writable home when running as non-root
ENV HOME=/tmp \
    SAL_USE_VCLPLUGIN=svp \
    DISPLAY=""

RUN groupadd -r nestjs && \
    useradd -r -g nestjs nestjs && \
    mkdir -p /home/nestjs/.local/share/pnpm

COPY package.json pnpm-lock.yaml tsconfig.json nest-cli.json prisma.config.ts ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/assets ./assets
# Maintenance scripts (pnpm portfolio:backfill-slugs, wa:test-reminders, …).
# Without this the package.json aliases resolve and then fail on a missing file,
# because only scripts/docker-entrypoint.sh reached the image — and it lands in
# /usr/local/bin, not /app/scripts. tsx and the Prisma client are already here,
# so the .ts sources run as-is.
COPY --from=builder /app/scripts ./scripts

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# 512 MB heap — leaves headroom for LibreOffice within the 700 MB compose cap
ENV NODE_ENV=production \
    CI=true \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=512" \
    PNPM_HOME="/home/nestjs/.local/share/pnpm" \
    FASTEMBED_CACHE_DIR=/var/cache/fastembed \
    FASTEMBED_MODEL_VERSION=v1

RUN mkdir -p /var/cache/fastembed && \
    chown -R nestjs:nestjs /app /home/nestjs /var/cache/fastembed

USER nestjs

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/src/worker"]

# ─── production — kept as default target for backwards compatibility ───────────
FROM api AS production
