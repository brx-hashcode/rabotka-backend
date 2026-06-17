#!/bin/sh
set -e

# ─── FastEmbed model cache bootstrap ──────────────────────────────────────────
# FASTEMBED_CACHE_DIR is set in the Dockerfile ENV.
# FASTEMBED_MODEL_VERSION is set there too — bump it whenever the model changes.
# On first run the volume is empty → download. On subsequent runs the marker
# file matches → skip. If the version changed → wipe old files and re-download.
FASTEMBED_MODEL_VERSION="${FASTEMBED_MODEL_VERSION:-v1}"
MARKER_FILE="${FASTEMBED_CACHE_DIR}/.model_version"

if [ -f "$MARKER_FILE" ] && [ "$(cat "$MARKER_FILE")" = "$FASTEMBED_MODEL_VERSION" ]; then
  echo "FastEmbed models already cached (${FASTEMBED_MODEL_VERSION}), skipping download."
else
  if [ -f "$MARKER_FILE" ]; then
    echo "FastEmbed model version changed ($(cat "$MARKER_FILE") → ${FASTEMBED_MODEL_VERSION}), clearing old cache..."
  else
    echo "FastEmbed cache is empty, downloading models..."
  fi
  rm -rf "${FASTEMBED_CACHE_DIR:?}"/*
  mkdir -p "$FASTEMBED_CACHE_DIR"
  node -e "
    const { FlagEmbedding, EmbeddingModel, SparseTextEmbedding, SparseEmbeddingModel } = require('fastembed');
    const cacheDir = process.env.FASTEMBED_CACHE_DIR;
    async function run() {
      console.log('Downloading BGESmallENV15...');
      await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir });
      console.log('Downloading SpladePPEnV1...');
      await SparseTextEmbedding.init({ model: SparseEmbeddingModel.SpladePPEnV1, cacheDir });
      console.log('FastEmbed models downloaded.');
    }
    run().then(() => process.exit(0)).catch(e => { console.error('FastEmbed download failed:', e); process.exit(1); });
  "
  echo "$FASTEMBED_MODEL_VERSION" > "$MARKER_FILE"
  echo "FastEmbed models cached successfully."
fi
# ──────────────────────────────────────────────────────────────────────────────

# Wait for database to be ready
echo "Waiting for database to be ready..."
until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-postgres}"; do
  echo "Database is unavailable - sleeping"
  sleep 1
done
echo "Database is ready!"

# Redis is guaranteed healthy by Docker depends_on healthcheck
echo "Redis is ready!"

# Deploy pending migrations using direct connection (bypasses PgBouncer)
echo "Running Prisma migrations..."
node node_modules/prisma/build/index.js migrate deploy
echo "Migrations deployed!"

# Execute the command
exec "$@"
