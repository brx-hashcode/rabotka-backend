-- Mailboxes a business connected to pick CVs from its e-mails (tokens only, encrypted).
CREATE TYPE "MailProvider" AS ENUM ('GMAIL', 'OUTLOOK');

CREATE TABLE "business_mailboxes" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "connected_by_profile_id" UUID NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "access_expires_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    CONSTRAINT "business_mailboxes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_mailboxes_business_id_provider_email_key" ON "business_mailboxes"("business_id", "provider", "email");
ALTER TABLE "business_mailboxes" ADD CONSTRAINT "business_mailboxes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
