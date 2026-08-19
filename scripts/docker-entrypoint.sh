#!/bin/sh
set -e

# The FastEmbed models are baked into the image (see the `fastembed` stage in
# the Dockerfile). They used to be downloaded here into a named volume, which
# cost a production incident: the volume outlived the image, the runtime uid
# changed between builds, and the download failed with EACCES mid-request.

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
