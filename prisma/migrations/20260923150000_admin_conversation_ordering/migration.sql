-- A global "newest activity first" order for the back-office conversations list.
--
-- `idx_profile_conversation_worker` and `_employer` both LEAD with a participant
-- column, so neither can serve an ORDER BY last_message_at across the whole
-- table: Postgres falls back to a sequential scan of profile_conversations plus
-- a full sort, on every page of the admin list, for as long as the table lives.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: Prisma Migrate runs a migration
-- inside a transaction, and CONCURRENTLY cannot. The table is days old. Should
-- this ever be applied to a large one, build the CONCURRENTLY version by hand
-- first and mark the migration applied.
CREATE INDEX "idx_profile_conversation_last_message"
  ON "profile_conversations"("last_message_at" DESC);
