#!/bin/sh
set -e

# Wait for database to be ready
echo "Waiting for database to be ready..."
until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-postgres}"; do
  echo "Database is unavailable - sleeping"
  sleep 1
done
echo "Database is ready!"

# Redis is guaranteed healthy by Docker depends_on healthcheck
echo "Redis is ready!"

# Deploy pending migrations
echo "Running Prisma migrations..."
pnpm exec prisma migrate deploy
echo "Migrations deployed!"

# Execute the command
exec "$@"
