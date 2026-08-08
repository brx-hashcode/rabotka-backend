-- Employment types, and a date that is no longer always required.
--
-- Every offer used to be a one-off gig at a specific hour: `scheduled_at` was
-- NOT NULL and the form demanded «Date et heure». That makes a CDI
-- unpostable — nobody can name the hour a permanent job starts.
--
-- MISSION is the default so every existing row keeps exactly its current
-- meaning without a backfill: they ARE one-off gigs, and they remain the only
-- type that requires a date and the only one that can be completed.
--
-- The date's meaning moves with this: it is now the CLOSING date, the point
-- after which the offer stops accepting applications. The column keeps its old
-- name — renaming it to `closes_at` touches ~50 call sites and is deliberately
-- a separate change rather than one buried in a feature.
--
-- Dropping NOT NULL rather than storing a sentinel far-future date: every
-- consumer would otherwise have to know that year 9999 means "no deadline",
-- and nothing would force them to. The four systems that read this column
-- (reminders, auto-start, expiry, the feed) each get an explicit NULL policy
-- instead — notably expiry, which is the only thing that ever retires an offer
-- and now falls back to created_at + 30 days.
CREATE TYPE "EmploymentType" AS ENUM ('MISSION', 'CDD', 'CDI', 'STAGE');

ALTER TABLE "job_offers"
  ADD COLUMN "employment_type" "EmploymentType" NOT NULL DEFAULT 'MISSION';

ALTER TABLE "job_offers"
  ALTER COLUMN "scheduled_at" DROP NOT NULL;
