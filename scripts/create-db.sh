#!/bin/bash
# Script to create the rabotka database if it doesn't exist
# Usage: ./scripts/create-db.sh

set -e

DB_NAME="rabotka"
DB_USER="postgres"
DB_PASSWORD="postgres"
DB_HOST="localhost"
DB_PORT="5432"

echo "Creating database '$DB_NAME' if it doesn't exist..."

PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d postgres <<-EOSQL
    SELECT 'CREATE DATABASE $DB_NAME'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec
EOSQL

echo "Database '$DB_NAME' is ready!"
