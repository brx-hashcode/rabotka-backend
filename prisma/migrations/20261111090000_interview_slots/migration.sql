-- Interview slots: up to three times offered, the candidate picks one.
CREATE TABLE "interview_slots" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "interview_slots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_interview_slot_interview" ON "interview_slots"("interview_id");

ALTER TABLE "interview_slots" ADD CONSTRAINT "interview_slots_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
