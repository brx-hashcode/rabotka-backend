-- Two CVs read at the same moment each opened the offer's shared screening, so
-- its candidates were in two groups that could not be compared. Their CVs and
-- conversations move to the first one; the emptied ones go.
-- All or nothing, and the list made once serves every step: outside a
-- transaction it would be dropped after the first statement.
BEGIN;

CREATE TEMP TABLE "screening_merge" ON COMMIT DROP AS
SELECT s."id", k."id" AS "keep_id"
FROM "cv_screenings" s
JOIN LATERAL (
  SELECT f."id" FROM "cv_screenings" f
  WHERE f."offer_id" = s."offer_id" AND f."business_id" = s."business_id" AND f."external"
  ORDER BY f."created_at", f."id"
  LIMIT 1
) k ON true
WHERE s."external" AND s."offer_id" IS NOT NULL AND s."id" <> k."id";

-- Where each CV was charged, kept before it leaves the screening that said it.
UPDATE "cv_screening_resumes" r
SET "subscription_id" = s."subscription_id"
FROM "screening_merge" m
JOIN "cv_screenings" s ON s."id" = m."id"
WHERE r."screening_id" = m."id" AND r."subscription_id" IS NULL;

UPDATE "cv_screenings" k
SET "expires_at" = GREATEST(k."expires_at", g."expires_at"),
    "purged_at" = CASE WHEN g."alive" THEN NULL ELSE k."purged_at" END,
    "status" = CASE WHEN g."reading" THEN 'PROCESSING'::"CvScreeningStatus" ELSE k."status" END
FROM (
  SELECT m."keep_id", MAX(s."expires_at") AS "expires_at",
         BOOL_OR(s."purged_at" IS NULL) AS "alive",
         BOOL_OR(s."status" = 'PROCESSING') AS "reading"
  FROM "screening_merge" m JOIN "cv_screenings" s ON s."id" = m."id"
  GROUP BY m."keep_id"
) g
WHERE k."id" = g."keep_id";

UPDATE "cv_screening_resumes" r SET "screening_id" = m."keep_id"
FROM "screening_merge" m WHERE r."screening_id" = m."id";

-- A selection is made of CVs of one screening: none can exist on both sides.
UPDATE "cv_comparisons" c SET "screening_id" = m."keep_id"
FROM "screening_merge" m WHERE c."screening_id" = m."id";

DELETE FROM "cv_screenings" s USING "screening_merge" m
WHERE s."id" = m."id"
  AND NOT EXISTS (SELECT 1 FROM "cv_screening_resumes" r WHERE r."screening_id" = s."id");

COMMIT;
