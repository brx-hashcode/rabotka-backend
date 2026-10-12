-- Data fix, no schema change.
--
-- Bell notifications that lead to a deleted offer, or to one of its
-- applications, opened a page that 404s. Deleting an offer now unlinks them
-- (`JobOfferService.unlinkOfferNotifications`); this does the same for offers
-- deleted before that. The notifications are kept — only the link goes.
-- Paths mirror `offerNotificationLinks`.
UPDATE "profile_notifications"
SET "link" = NULL
WHERE "link" IN (
  SELECT '/offres/' || o."id"::text FROM "job_offers" o WHERE o."deleted_at" IS NOT NULL
  UNION ALL
  SELECT '/missions/' || o."id"::text FROM "job_offers" o WHERE o."deleted_at" IS NOT NULL
  UNION ALL
  SELECT '/job-offers/' || o."id"::text FROM "job_offers" o WHERE o."deleted_at" IS NOT NULL
  UNION ALL
  SELECT '/candidatures/' || a."id"::text
    FROM "applications" a JOIN "job_offers" o ON o."id" = a."job_offer_id"
    WHERE o."deleted_at" IS NOT NULL
  UNION ALL
  SELECT '/applications/' || a."id"::text
    FROM "applications" a JOIN "job_offers" o ON o."id" = a."job_offer_id"
    WHERE o."deleted_at" IS NOT NULL
  UNION ALL
  SELECT '/applications/' || a."id"::text || '/paiement'
    FROM "applications" a JOIN "job_offers" o ON o."id" = a."job_offer_id"
    WHERE o."deleted_at" IS NOT NULL
);
