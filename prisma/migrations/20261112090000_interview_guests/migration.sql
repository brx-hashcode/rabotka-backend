-- Others a business invites into an interview's visio, by a personal link.
CREATE TABLE "interview_guests" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interview_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_member_id" UUID,

    CONSTRAINT "interview_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interview_guests_token_hash_key" ON "interview_guests"("token_hash");
CREATE UNIQUE INDEX "interview_guests_interview_id_email_key" ON "interview_guests"("interview_id", "email");

ALTER TABLE "interview_guests" ADD CONSTRAINT "interview_guests_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
