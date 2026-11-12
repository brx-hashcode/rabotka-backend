-- « Transcrire l'entretien »: each side's own voice, as text, for the compte rendu.
ALTER TABLE "interviews" ADD COLUMN "transcribe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "interviews" ADD COLUMN "transcript_consent" TEXT;

CREATE TABLE "interview_transcript_lines" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interview_id" UUID NOT NULL,
    "spoken_at" TIMESTAMPTZ NOT NULL,
    "speaker" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "interview_transcript_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_interview_transcript_time" ON "interview_transcript_lines"("interview_id", "spoken_at");

ALTER TABLE "interview_transcript_lines" ADD CONSTRAINT "interview_transcript_lines_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
