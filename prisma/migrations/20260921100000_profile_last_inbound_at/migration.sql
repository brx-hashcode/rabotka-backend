-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "last_inbound_at" TIMESTAMP(3);

-- Backfill from the table the window was derived from until now, so the new
-- column is authoritative from its first read: a NULL after this means the
-- profile has genuinely never written to us on WhatsApp, which is exactly what
-- `isServiceWindowOpen` concluded from an empty query before.
UPDATE "profiles" p
SET "last_inbound_at" = m.last_in
FROM (
  SELECT profile_id, max(created_at) AS last_in
  FROM "messages"
  WHERE direction = 'INBOUND'
    AND platform = 'WHATSAPP'
  GROUP BY profile_id
) m
WHERE m.profile_id = p.id;

-- CreateIndex
-- For the fan-outs this column exists for: "who is inside the window". Declared
-- in schema.prisma too, so `migrate dev` reports no drift — Prisma cannot
-- express a partial index, and an index it does not know about looks like one.
CREATE INDEX "idx_profile_last_inbound" ON "profiles"("last_inbound_at" DESC);
