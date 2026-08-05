-- Remote job offers.
--
-- A job that is done from anywhere has no site to travel to, so `address`
-- stops being mandatory. Storing '' instead of NULL was rejected: every
-- consumer would have to know that an empty string means "remote" rather than
-- "we lost the address", and nothing would force them to.
ALTER TABLE "job_offers"
  ADD COLUMN "is_remote" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "job_offers"
  ALTER COLUMN "address" DROP NOT NULL;
