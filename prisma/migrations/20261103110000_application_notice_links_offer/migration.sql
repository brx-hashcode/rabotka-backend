-- « Nouvelle candidature » notices from before their link named the offer:
-- add it (`?offre=`), so the business space opens the offer on the
-- candidate directly instead of going through Candidatures. The client app
-- reads the path only and is unaffected. Both kinds: Rabotka applications
-- and careers-page ones (their notice carries the outside application's id).
UPDATE "profile_notifications" AS n
SET "link" = n."link" || '?offre=' || a."job_offer_id"::text
FROM "applications" AS a
WHERE n."link" = '/candidatures/' || a."id"::text;

UPDATE "profile_notifications" AS n
SET "link" = n."link" || '?offre=' || e."job_offer_id"::text
FROM "external_applications" AS e
WHERE n."link" = '/candidatures/' || e."id"::text;
