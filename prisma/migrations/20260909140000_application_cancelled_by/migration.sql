-- CreateEnum
CREATE TYPE "ApplicationCancelledBy" AS ENUM ('WORKER', 'EMPLOYER', 'SYSTEM');

-- AlterTable
--
-- Who cancelled, and therefore whether the worker may apply again. Only a
-- worker's own cancellation bars them.
ALTER TABLE "applications" ADD COLUMN "cancelled_by" "ApplicationCancelledBy";

-- Backfill ONLY what the platform demonstrably wrote itself. Every string below
-- is a literal emitted by a code path that updates the row directly; no worker
-- ever typed one.
UPDATE "applications" SET "cancelled_by" = 'SYSTEM'
WHERE "status" = 'CANCELLED'
  AND ("cancellation_reason" LIKE 'Offre expirée%'
    OR "cancellation_reason" LIKE 'Délai de paiement pour le déverrouillage expiré%');

UPDATE "applications" SET "cancelled_by" = 'EMPLOYER'
WHERE "status" = 'CANCELLED'
  AND "cancellation_reason" LIKE 'Annulée par l''employeur%';

-- Everything else stays NULL, and that is deliberate. There is NO backfill to
-- 'WORKER'. The ghost-cancel bug (fixed in #709) wrote workers' innocent
-- free-text replies through `ApplicationService.cancel()` itself — same code
-- path, same columns, as a deliberate cancellation. Nothing in the data
-- separates them, so guessing 'WORKER' would permanently bar exactly the people
-- that fix was merged to unbar. NULL reads as "unknown" and fails open.

-- DropIndex
--
-- Replaced by a PARTIAL unique index. The old constraint made a second row
-- impossible for a pair, so re-applying after a cancellation could not be
-- expressed at all — not even in principle.
DROP INDEX "applications_job_offer_id_worker_id_key";

-- CreateIndex
--
-- One LIVE application per (offer, worker); as many cancelled rows as history
-- produced. A new application is therefore a new row, which is what keeps its
-- assignment, its contract and its contact-unlock attempt new too — reusing the
-- cancelled row would have collided with all three, each of which is unique on
-- application_id.
--
-- Prisma cannot express a partial index, so this exists only here. A future
-- `migrate dev` will report drift and offer to drop it: say no.
CREATE UNIQUE INDEX "applications_live_unique"
  ON "applications" ("job_offer_id", "worker_id")
  WHERE "status" <> 'CANCELLED';

-- CreateIndex
CREATE INDEX "idx_application_pair" ON "applications" ("job_offer_id", "worker_id");
