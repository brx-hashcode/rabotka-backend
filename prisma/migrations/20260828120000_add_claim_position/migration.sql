-- AlterTable
ALTER TABLE "claims" ADD COLUMN "position" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Backfill: keep the order the board shows today (newest first within each
-- column), spaced by 1000 so the first few drags land on clean midpoints
-- rather than immediately chasing float precision.
WITH ranked AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (PARTITION BY "status" ORDER BY "created_at" DESC) AS rn
    FROM "claims"
)
UPDATE "claims" AS c
SET "position" = ranked.rn * 1000
FROM ranked
WHERE c."id" = ranked."id";

-- CreateIndex
CREATE INDEX "claims_status_position_idx" ON "claims"("status", "position");
