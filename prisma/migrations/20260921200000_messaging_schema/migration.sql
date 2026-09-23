-- CreateEnum
CREATE TYPE "MessageModerationStatus" AS ENUM ('CLEAN', 'REDACTED', 'HELD');

-- CreateEnum
CREATE TYPE "RedactionCategory" AS ENUM ('PHONE', 'EMAIL', 'MESSAGING_HANDLE', 'URL', 'OBFUSCATED_DIGITS');

-- CreateTable
CREATE TABLE "profile_conversations" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "worker_id" UUID NOT NULL,
    "employer_id" UUID NOT NULL,
    "application_id" UUID,
    "last_message_at" TIMESTAMP(3),
    "worker_last_read_at" TIMESTAMP(3),
    "employer_last_read_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "profile_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "moderation_status" "MessageModerationStatus" NOT NULL DEFAULT 'CLEAN',
    "semantic_flagged" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "profile_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_redactions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_id" UUID NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "category" "RedactionCategory" NOT NULL,
    "matched_by" TEXT NOT NULL,

    CONSTRAINT "message_redactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redaction_reports" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" UUID,
    "upheld" BOOLEAN,

    CONSTRAINT "redaction_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_conversations_application_id_key" ON "profile_conversations"("application_id");

-- CreateIndex
CREATE INDEX "idx_profile_conversation_worker" ON "profile_conversations"("worker_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "idx_profile_conversation_employer" ON "profile_conversations"("employer_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "idx_profile_message_conversation" ON "profile_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_profile_message_sender" ON "profile_messages"("sender_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_message_redaction_message" ON "message_redactions"("message_id");

-- CreateIndex
CREATE INDEX "idx_message_redaction_category" ON "message_redactions"("category");

-- CreateIndex
CREATE INDEX "idx_redaction_report_pending" ON "redaction_reports"("reviewed_at");

-- CreateIndex
CREATE INDEX "idx_redaction_report_message" ON "redaction_reports"("message_id");

-- AddForeignKey
ALTER TABLE "profile_conversations" ADD CONSTRAINT "profile_conversations_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_conversations" ADD CONSTRAINT "profile_conversations_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_conversations" ADD CONSTRAINT "profile_conversations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_messages" ADD CONSTRAINT "profile_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "profile_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_messages" ADD CONSTRAINT "profile_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_redactions" ADD CONSTRAINT "message_redactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "profile_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redaction_reports" ADD CONSTRAINT "redaction_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "profile_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redaction_reports" ADD CONSTRAINT "redaction_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redaction_reports" ADD CONSTRAINT "redaction_reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Two rules Prisma cannot express, enforced here so that a bug in the
-- service is stopped by the database instead of by somebody reading their
-- own message with a hole in the wrong place.

-- A redaction is a half-open span inside the body. Reversed or negative
-- offsets would slice the wrong characters silently.
ALTER TABLE "message_redactions"
  ADD CONSTRAINT "message_redactions_span_valid"
  CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset");

-- A conversation is between two DIFFERENT people. Nothing in the foreign keys
-- says so, and a self-conversation would read as a valid row everywhere.
ALTER TABLE "profile_conversations"
  ADD CONSTRAINT "profile_conversations_distinct_parties"
  CHECK ("worker_id" <> "employer_id");
