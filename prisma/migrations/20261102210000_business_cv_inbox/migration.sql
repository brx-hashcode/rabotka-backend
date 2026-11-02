-- Forwarding CVs: each business gets its own address, and the mails it
-- forwards are kept (their CV files in the private bucket) until picked.
ALTER TABLE "businesses" ADD COLUMN "inbox_token" TEXT;
CREATE UNIQUE INDEX "businesses_inbox_token_key" ON "businesses"("inbox_token");

CREATE TABLE "business_inbox_mails" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_id" UUID NOT NULL,
    "from_name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "business_inbox_mails_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_business_inbox_mail_business_created" ON "business_inbox_mails"("business_id", "created_at");
ALTER TABLE "business_inbox_mails" ADD CONSTRAINT "business_inbox_mails_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
