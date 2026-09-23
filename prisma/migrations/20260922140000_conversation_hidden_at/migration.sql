-- Per-side "delete conversation". Nullable, no backfill: nothing is hidden
-- until somebody hides it. Adding nullable columns without a default is a
-- metadata-only change in Postgres — no table rewrite, no long lock.
ALTER TABLE "profile_conversations" ADD COLUMN "worker_hidden_at" TIMESTAMP(3);
ALTER TABLE "profile_conversations" ADD COLUMN "employer_hidden_at" TIMESTAMP(3);
