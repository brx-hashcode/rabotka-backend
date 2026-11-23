-- « Fichier »: a question the candidate answers with a document.
ALTER TYPE "OfferQuestionKind" ADD VALUE 'FILE';

CREATE TABLE "answer_files" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "job_offer_id" UUID NOT NULL,
    "profile_id" UUID,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT,
    "storage_bucket" TEXT,
    "text" TEXT,
    "attached_at" TIMESTAMPTZ,

    CONSTRAINT "answer_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_answer_file_created" ON "answer_files"("created_at");

ALTER TABLE "answer_files" ADD CONSTRAINT "answer_files_job_offer_id_fkey" FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
