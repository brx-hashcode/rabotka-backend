-- Broadcasts used to write an email row for every profile in the audience,
-- address or not, and settled the ones without an address as FAILED
-- (« Non délivré »: on the email channel that message only ever meant « no
-- address »). They now get no row at all; take the old ones out the same way,
-- with the broadcasts' totals, so « 126/130 · 4 failed » reads « 126/126 ».
WITH dropped AS (
  DELETE FROM "broadcast_recipients"
  WHERE "channel" = 'EMAIL'
    AND "status" = 'FAILED'
    AND "error" = 'Non délivré'
  RETURNING "broadcast_id"
), per_broadcast AS (
  SELECT "broadcast_id", COUNT(*)::int AS n FROM dropped GROUP BY "broadcast_id"
)
UPDATE "broadcasts" AS b
SET "failed_count" = GREATEST(b."failed_count" - p.n, 0),
    "recipient_count" = GREATEST(b."recipient_count" - p.n, 0)
FROM per_broadcast AS p
WHERE b."id" = p."broadcast_id";
