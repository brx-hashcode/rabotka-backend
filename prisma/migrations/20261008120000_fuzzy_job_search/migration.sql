-- Forgiving search (accents, case, misspellings) for the job and worker
-- searches of the client and agent apps — see src/common/queries/text-search.ts.
-- Both are "trusted" extensions (PG 13+): the database owner may create them.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
