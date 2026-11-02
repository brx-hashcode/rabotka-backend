-- A business's talent pool, and the invitation it sends from there.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'JOB_INVITATION';

CREATE TABLE "business_talents" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "employer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "note" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "business_talents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "business_talents_employer_id_worker_id_key" ON "business_talents"("employer_id", "worker_id");
CREATE INDEX "idx_business_talent_employer" ON "business_talents"("employer_id");

ALTER TABLE "business_talents" ADD CONSTRAINT "business_talents_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_talents" ADD CONSTRAINT "business_talents_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
