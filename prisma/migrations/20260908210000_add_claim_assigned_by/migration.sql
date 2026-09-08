-- AlterTable
--
-- Who performed the current assignment. Only that person (or a SUPER_ADMIN)
-- may change the assignee afterwards, so that somebody assigned to a claim
-- cannot quietly drop it.
--
-- Deliberately NOT backfilled. Existing assignments have no record of who made
-- them, and guessing — `created_by_user_id`, say — would lock rows against a
-- person who may never have assigned anyone. NULL reads as "unknown assigner",
-- which leaves those claims freely editable until the next assignment sets it.
ALTER TABLE "claims" ADD COLUMN "assigned_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_assigned_by_user_id_fkey"
  FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
