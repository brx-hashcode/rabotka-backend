-- AlterTable penalties: rename worker_id to profile_id, make application_id optional
ALTER TABLE "penalties" RENAME COLUMN "worker_id" TO "profile_id";
ALTER TABLE "penalties" ALTER COLUMN "application_id" DROP NOT NULL;

-- Drop old index and foreign key constraints, recreate with new names
DROP INDEX IF EXISTS "idx_penalty_worker";
CREATE INDEX "idx_penalty_profile" ON "penalties"("profile_id");

-- The foreign key on worker_id/profile_id: PostgreSQL doesn't rename FK constraints easily,
-- so we drop and recreate
ALTER TABLE "penalties" DROP CONSTRAINT IF EXISTS "penalties_worker_id_fkey";
ALTER TABLE "penalties" ADD CONSTRAINT "penalties_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Make application FK optional (already nullable column, constraint stays but ON DELETE SET NULL behavior)
-- The existing FK on application_id is fine as-is since the column is now nullable
