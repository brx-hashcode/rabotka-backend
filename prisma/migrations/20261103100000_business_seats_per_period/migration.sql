-- Team places are counted per period, like the contacts and the offers: a new
-- period (renewal or change of plan) frees them, the people already in the
-- team stay.

-- AlterTable
ALTER TABLE "business_subscriptions" ADD COLUMN     "recruiters_added" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewers_added" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "business_members" ADD COLUMN     "seat_subscription_id" UUID;

-- Backfill: each current invitation or member takes a place on the period it
-- was invited in.
UPDATE "business_members" m
SET "seat_subscription_id" = s."id"
FROM "business_subscriptions" s
WHERE s."business_id" = m."business_id"
  AND s."status" IN ('ACTIVE', 'TRIAL')
  AND m."is_owner" = false
  AND m."status" IN ('INVITED', 'ACTIVE')
  AND m."invited_at" >= s."starts_at"
  AND m."invited_at" < s."ends_at";

UPDATE "business_subscriptions" s
SET "recruiters_added" = c."recruiters",
    "reviewers_added" = c."reviewers"
FROM (
  SELECT "seat_subscription_id" AS id,
         COUNT(*) FILTER (WHERE "role" = 'RECRUITER') AS recruiters,
         COUNT(*) FILTER (WHERE "role" = 'REVIEWER') AS reviewers
  FROM "business_members"
  WHERE "seat_subscription_id" IS NOT NULL
  GROUP BY "seat_subscription_id"
) c
WHERE s."id" = c.id;
