-- Team members (gaps plan, Phase 2): people of the organisation who sign in to
-- the business space and act as its profile, their activity, and their private
-- notes and opinions on applications.

-- CreateEnum
CREATE TYPE "BusinessMemberRole" AS ENUM ('ADMIN', 'RECRUITER', 'REVIEWER');

-- CreateEnum
CREATE TYPE "BusinessMemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "CandidateOpinionVerdict" AS ENUM ('YES', 'MAYBE', 'NO');

-- AlterTable
ALTER TABLE "business_plans" ADD COLUMN     "recruiters_limit" INTEGER DEFAULT 0,
ADD COLUMN     "reviewers_limit" INTEGER DEFAULT 0;

-- CreateTable
CREATE TABLE "business_members" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "BusinessMemberRole" NOT NULL,
    "status" "BusinessMemberStatus" NOT NULL DEFAULT 'INVITED',
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "emails_on" BOOLEAN NOT NULL DEFAULT true,
    "invited_by_member_id" UUID,
    "invited_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "business_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_activities" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_id" UUID NOT NULL,
    "member_id" UUID,
    "action" TEXT NOT NULL,
    "target_id" TEXT,

    CONSTRAINT "business_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_notes" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "application_id" UUID,
    "external_application_id" UUID,
    "body" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "candidate_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_opinions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "application_id" UUID,
    "external_application_id" UUID,
    "verdict" "CandidateOpinionVerdict" NOT NULL,

    CONSTRAINT "candidate_opinions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_business_member_email_status" ON "business_members"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "business_members_business_id_email_key" ON "business_members"("business_id", "email");

-- CreateIndex
CREATE INDEX "idx_business_activity_business_created" ON "business_activities"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_candidate_note_application" ON "candidate_notes"("application_id");

-- CreateIndex
CREATE INDEX "idx_candidate_note_external" ON "candidate_notes"("external_application_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_opinions_member_id_application_id_key" ON "candidate_opinions"("member_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_opinions_member_id_external_application_id_key" ON "candidate_opinions"("member_id", "external_application_id");

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_activities" ADD CONSTRAINT "business_activities_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_activities" ADD CONSTRAINT "business_activities_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "business_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "business_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_external_application_id_fkey" FOREIGN KEY ("external_application_id") REFERENCES "external_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_opinions" ADD CONSTRAINT "candidate_opinions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_opinions" ADD CONSTRAINT "candidate_opinions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "business_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_opinions" ADD CONSTRAINT "candidate_opinions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_opinions" ADD CONSTRAINT "candidate_opinions_external_application_id_fkey" FOREIGN KEY ("external_application_id") REFERENCES "external_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A note or an opinion is on exactly one application: a Rabotka one or an outside one.
ALTER TABLE "candidate_notes" ADD CONSTRAINT "candidate_notes_one_application"
  CHECK (("application_id" IS NULL) <> ("external_application_id" IS NULL));
ALTER TABLE "candidate_opinions" ADD CONSTRAINT "candidate_opinions_one_application"
  CHECK (("application_id" IS NULL) <> ("external_application_id" IS NULL));

-- Every existing business gets its account holder as an active administrator.
INSERT INTO "business_members" ("id", "updated_at", "business_id", "email", "name", "role", "status", "is_owner", "emails_on", "joined_at")
SELECT gen_random_uuid(), now(), b."id", lower(p."email"),
       coalesce(nullif(trim(concat_ws(' ', p."first_name", p."last_name")), ''), b."name"),
       'ADMIN', 'ACTIVE', true, true, b."created_at"
FROM "businesses" b
JOIN "profiles" p ON p."id" = b."profile_id"
WHERE p."email" IS NOT NULL
ON CONFLICT ("business_id", "email") DO NOTHING;
