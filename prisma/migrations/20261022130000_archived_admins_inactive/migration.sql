-- Archiving an admin now also deactivates it (pentest A2-F01, #857). Admins
-- archived before that still have is_active = true and can log in again: bring
-- them in line. Restoring an archive does not reactivate; that stays a
-- deliberate admin action.
UPDATE "users" SET "is_active" = false WHERE "deleted_at" IS NOT NULL AND "is_active" = true;
