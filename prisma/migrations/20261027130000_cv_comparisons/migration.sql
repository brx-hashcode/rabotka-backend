-- Comparing several analysed CVs of one screening in one conversation.
CREATE TABLE "cv_comparisons" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "screening_id" UUID NOT NULL,
    "resume_ids" TEXT[],
    "selection" TEXT NOT NULL,

    CONSTRAINT "cv_comparisons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cv_comparison_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comparison_id" UUID NOT NULL,
    "role" "CvChatRole" NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "cv_comparison_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cv_comparisons_screening_id_selection_key" ON "cv_comparisons"("screening_id", "selection");
CREATE INDEX "idx_cv_comparison_message_comparison_created" ON "cv_comparison_messages"("comparison_id", "created_at");

ALTER TABLE "cv_comparisons" ADD CONSTRAINT "cv_comparisons_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "cv_screenings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cv_comparison_messages" ADD CONSTRAINT "cv_comparison_messages_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "cv_comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
