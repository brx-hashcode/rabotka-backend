-- CreateEnum
--
-- What put an account in SUSPENDED, so paying penalties only lifts a
-- penalty suspension — never one imposed by an admin or by repeated
-- cancellations.
CREATE TYPE "SuspensionSource" AS ENUM ('ADMIN', 'UNPAID_PENALTIES', 'REPEATED_CANCELLATIONS');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN "suspension_source" "SuspensionSource";

-- AlterTable
--
-- The status a worker cancellation left: only walking away from a committed
-- mission (ACCEPTED / WAITING_PAYMENT / an undone hire) counts toward the
-- repeated-cancellation suspension.
ALTER TABLE "applications" ADD COLUMN "cancelled_from_status" "ApplicationStatus";

-- CreateIndex
--
-- Hand-written, like every migration touching "applications": a generated one
-- would also try to drop the raw-SQL partial index `applications_live_unique`.
CREATE INDEX "idx_application_worker_cancellations" ON "applications"("worker_id", "cancelled_by", "cancelled_at");
