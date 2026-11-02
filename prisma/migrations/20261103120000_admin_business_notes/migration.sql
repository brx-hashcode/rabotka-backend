-- Rabotka's own follow-up notes on a business, written in rabotka-admin.
CREATE TABLE "admin_business_notes" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "admin_business_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_admin_business_note_business_created" ON "admin_business_notes"("business_id", "created_at");

ALTER TABLE "admin_business_notes" ADD CONSTRAINT "admin_business_notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_business_notes" ADD CONSTRAINT "admin_business_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
