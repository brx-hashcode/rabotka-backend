#!/bin/bash
set -e

# This script runs automatically when PostgreSQL container starts for the first time
# It ensures the rabotka database exists
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE rabotka'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rabotka')\gexec
EOSQL
