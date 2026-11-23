-- A business imports CVs into an offer (from its computer or its mailbox):
-- they join the careers-page candidates, with no contact until the CV is read.
CREATE TYPE "ExternalApplicationOrigin" AS ENUM ('CAREERS', 'IMPORT');

ALTER TABLE "external_applications"
  ADD COLUMN "origin" "ExternalApplicationOrigin" NOT NULL DEFAULT 'CAREERS',
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "phone" DROP NOT NULL,
  ALTER COLUMN "consented_at" DROP NOT NULL;
