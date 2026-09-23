-- One direct conversation per (worker, employer) pair.
--
-- PARTIAL, on the application-less rows only. A pair may have any number of
-- conversations anchored on applications — one per application, which the
-- unique on application_id already enforces — but exactly one that is not.
--
-- Prisma cannot express a partial index, so this lives only here and a future
-- `migrate dev` will offer to drop it. SAY NO, and carry it forward by hand.
-- `applications_live_unique` carries the same warning for the same reason.
--
-- This is also what makes "open the conversation" idempotent under a double
-- tap: the loser of the race gets P2002 and re-reads, exactly as the
-- application path does.
CREATE UNIQUE INDEX "profile_conversations_direct_pair"
  ON "profile_conversations" ("worker_id", "employer_id")
  WHERE "application_id" IS NULL;
