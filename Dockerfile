# Both stages use Debian slim — single base image, no Alpine/apk DNS issues
FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

# --ignore-scripts skips postinstall (prisma generate) which crashes due to
# a transitive ESM/CJS conflict in @prisma/dev bundled with prisma@7.x
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Rebuild native addons skipped by --ignore-scripts
RUN pnpm rebuild sharp better-sqlite3

# Copy prisma schema before generating client
COPY prisma ./prisma/

# Generate Prisma client explicitly
RUN pnpm exec prisma generate

COPY . .

RUN pnpm run build

# Pre-download fastembed models at build time so the container never needs
# outbound internet access to HuggingFace at runtime.
RUN for i in 1 2 3; do \
    node -e " \
      const { FlagEmbedding, EmbeddingModel, SparseTextEmbedding, SparseEmbeddingModel } = require('fastembed'); \
      const cacheDir = '/app/fastembed_cache'; \
      Promise.all([ \
        FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir }), \
        SparseTextEmbedding.init({ model: SparseEmbeddingModel.SpladePPEnV1, cacheDir }), \
      ]).then(() => { console.log('fastembed models cached'); process.exit(0); }) \
        .catch(e => { console.error(e); process.exit(1); }); \
    " && break || { echo "Attempt $i failed, retrying in 10s..."; sleep 10; }; \
  done

# ─── api target — slim, no LibreOffice ────────────────────────────────────────
FROM node:22-slim AS api

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        postgresql-client \
        libreoffice-writer \
        fonts-liberation \
        fonts-dejavu-core \
        fontconfig && \
    fc-cache -f && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm && \
    groupadd -r nestjs && \
    useradd -r -g nestjs nestjs && \
    mkdir -p /home/nestjs/.local/share/pnpm

COPY package.json pnpm-lock.yaml tsconfig.json nest-cli.json prisma.config.ts ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/fastembed_cache ./fastembed_cache

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=2048" \
    PNPM_HOME="/home/nestjs/.local/share/pnpm" \
    HOME=/tmp \
    SAL_USE_VCLPLUGIN=svp \
    DISPLAY="" \
    FASTEMBED_CACHE_DIR=/app/fastembed_cache

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
COPY --from=builder /app/fastembed_cache ./fastembed_cache

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# 512 MB heap — leaves headroom for LibreOffice within the 700 MB compose cap
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=512" \
    PNPM_HOME="/home/nestjs/.local/share/pnpm" \
    FASTEMBED_CACHE_DIR=/app/fastembed_cache

RUN chown -R nestjs:nestjs /app /home/nestjs

USER nestjs

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/src/worker"]

# ─── production — kept as default target for backwards compatibility ───────────
FROM api AS production
