-- Chat with an analysed CV: how many questions a plan allows per CV, and
-- the conversation itself.
ALTER TABLE "business_plans" ADD COLUMN "cv_chat_questions" INTEGER NOT NULL DEFAULT 20;

CREATE TYPE "CvChatRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "cv_resume_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resume_id" UUID NOT NULL,
    "role" "CvChatRole" NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "cv_resume_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_cv_resume_message_resume_created" ON "cv_resume_messages"("resume_id", "created_at");

ALTER TABLE "cv_resume_messages" ADD CONSTRAINT "cv_resume_messages_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "cv_screening_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
