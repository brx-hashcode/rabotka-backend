-- Postgres cannot drop an enum value. Rolling back means: delete the rows
-- that use them, recreate the type without them, and swap. Only needed if the
-- values must go; leaving them unused is harmless.
DELETE FROM "profile_notifications" WHERE "type" IN ('BUSINESS_VERIFIED', 'BUSINESS_REJECTED');
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023130000_business_review_notifications';
