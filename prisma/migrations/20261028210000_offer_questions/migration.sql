-- Questions an offer asks its candidates, and their answers.
CREATE TYPE "OfferQuestionKind" AS ENUM ('YES_NO', 'CHOICE', 'SHORT_TEXT');

ALTER TABLE "applications" ADD COLUMN "knocked_out" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "offer_questions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "job_offer_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "OfferQuestionKind" NOT NULL,
    "label" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT true,
    "knockout" BOOLEAN NOT NULL DEFAULT false,
    "accepted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "offer_questions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "offer_questions_job_offer_id_position_idx" ON "offer_questions"("job_offer_id", "position");
ALTER TABLE "offer_questions" ADD CONSTRAINT "offer_questions_job_offer_id_fkey" FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "application_answers" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "application_id" UUID NOT NULL,
    "question_id" UUID,
    "label" TEXT NOT NULL,
    "kind" "OfferQuestionKind" NOT NULL,
    "value" TEXT NOT NULL,
    "passed" BOOLEAN,
    CONSTRAINT "application_answers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_answers_application_id_question_id_key" ON "application_answers"("application_id", "question_id");
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "offer_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
