-- CreateEnum
CREATE TYPE "ContactRecordOrigin" AS ENUM ('MISSION', 'DIRECT');

-- CreateTable
--
-- Every time an employer PAID to reach a worker, whatever route they took.
--
-- The two unlock paths recorded themselves differently and one recorded nothing
-- at all: the mission path writes a ContactUnlockAttempt, while the
-- recommendation path is stateless and leaves only a wallet transaction whose
-- reference_id is a bare worker uuid. "Who has this employer paid to reach?"
-- therefore had to be reconstructed from payment rows at read time, and admin
-- could not answer it at all.
--
-- A ledger, not a state machine: append-only facts about money that moved. The
-- attempt table keeps its two-sided payment state, expiry and refunds — none of
-- which apply to a direct unlock, which is why this is a separate table rather
-- than a nullable application_id on that one.
CREATE TABLE "contact_records" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "employer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "origin" "ContactRecordOrigin" NOT NULL,
    -- What the EMPLOYER paid. On a multi-seat offer the employer pays once for
    -- the whole job, so each row carries the per-attempt fee — sum by
    -- job_offer_id, not by row, or one payment counts N times.
    "amount" DECIMAL(10,2) NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL,
    -- Set for MISSION only; all three are NULL for a DIRECT unlock.
    "job_offer_id" UUID,
    "application_id" UUID,
    "contact_unlock_attempt_id" UUID,
    -- Whichever settled the money. Both NULL on backfilled rows.
    "payment_id" UUID,
    "payment_request_id" UUID,

    CONSTRAINT "contact_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- One ledger row per mission unlock, so a retried payUnlock or the multi-seat
-- cascade cannot double-write. Postgres allows many NULLs in a unique index,
-- which is what leaves DIRECT rows unconstrained — deliberately, because the
-- rule here is one row per PAYMENT, not per pair. An employer who pays twice
-- for the same worker is charged twice and gets two rows.
CREATE UNIQUE INDEX "contact_records_contact_unlock_attempt_id_key" ON "contact_records" ("contact_unlock_attempt_id");

-- CreateIndex
CREATE INDEX "idx_contact_record_pair" ON "contact_records" ("employer_id", "worker_id");

-- CreateIndex
CREATE INDEX "idx_contact_record_employer" ON "contact_records" ("employer_id");

-- CreateIndex
CREATE INDEX "idx_contact_record_worker" ON "contact_records" ("worker_id");

-- CreateIndex
CREATE INDEX "idx_contact_record_origin" ON "contact_records" ("origin");

-- CreateIndex
CREATE INDEX "idx_contact_record_unlocked_at" ON "contact_records" ("unlocked_at");

-- AddForeignKey
ALTER TABLE "contact_records" ADD CONSTRAINT "contact_records_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_records" ADD CONSTRAINT "contact_records_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- SET NULL rather than CASCADE: a purged job offer must not erase the record
-- that money changed hands over it.
ALTER TABLE "contact_records" ADD CONSTRAINT "contact_records_job_offer_id_fkey" FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
