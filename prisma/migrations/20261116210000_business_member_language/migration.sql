-- The language a member of a business reads Rabotka Business in (its screens,
-- then its e-mails). Kept up to date from the app; French until it says.
ALTER TABLE "business_members" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'fr';
