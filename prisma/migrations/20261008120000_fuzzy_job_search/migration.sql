-- Forgiving job search on the agent app: accents, case and spelling.
-- Both are "trusted" extensions (PG 13+): the database owner may create them.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
