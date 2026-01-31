#!/bin/sh
set -e

# Wait for database to be ready
echo "Waiting for database to be ready..."
until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-postgres}"; do
  echo "Database is unavailable - sleeping"
  sleep 1
done
echo "Database is ready!"

# Execute the command
exec "$@"
