-- A retained outside candidate now fills a post. Offers still open with one
-- already retained catch up, as the next retention would have done.
UPDATE "job_offers" o
SET "status" = CASE WHEN r.retained >= o."quantity"
                    THEN 'FILLED'::"JobOfferStatus"
                    ELSE 'PARTIALLY_FILLED'::"JobOfferStatus" END
FROM (
  SELECT "job_offer_id", count(*) AS retained
  FROM "external_applications"
  WHERE "status" = 'RETAINED'
  GROUP BY "job_offer_id"
) r
WHERE r."job_offer_id" = o."id" AND o."status" = 'ACTIVE';
