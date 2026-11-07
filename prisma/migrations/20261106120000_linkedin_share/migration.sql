-- Offers posted on LinkedIn from a team member's own connected account.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'LINKEDIN_POST';

CREATE TYPE "LinkedinPostStatus" AS ENUM ('QUEUED', 'PUBLISHED', 'FAILED');

CREATE TABLE "business_linkedin_accounts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "person" TEXT NOT NULL,
    "linkedin_sub" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "picture_url" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "expired_at" TIMESTAMP(3),

    CONSTRAINT "business_linkedin_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "business_linkedin_accounts_business_id_person_key" ON "business_linkedin_accounts"("business_id", "person");

ALTER TABLE "business_linkedin_accounts" ADD CONSTRAINT "business_linkedin_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "job_offer_linkedin_posts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "offer_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "person" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "LinkedinPostStatus" NOT NULL DEFAULT 'QUEUED',
    "post_urn" TEXT,
    "error" TEXT,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "job_offer_linkedin_posts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_offer_linkedin_posts_offer_id_created_at_idx" ON "job_offer_linkedin_posts"("offer_id", "created_at");

ALTER TABLE "job_offer_linkedin_posts" ADD CONSTRAINT "job_offer_linkedin_posts_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
