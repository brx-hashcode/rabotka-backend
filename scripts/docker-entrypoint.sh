#!/bin/sh
set -e

# Wait for database to be ready
echo "Waiting for database to be ready..."
until nc -z "${DB_HOST:-postgres}" "${DB_PORT:-5432}"; do
  echo "Database is unavailable - sleeping"
  sleep 1
done
echo "Database is ready!"

# Wait for Redis to be ready
echo "Waiting for Redis to be ready..."
until nc -z "${REDIS_HOST:-redis}" "${REDIS_PORT:-6379}"; do
  echo "Redis is unavailable - sleeping"
  sleep 1
done
echo "Redis is ready!"

# Execute the command
exec "$@"
