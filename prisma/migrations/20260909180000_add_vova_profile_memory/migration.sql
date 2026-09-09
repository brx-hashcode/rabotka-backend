-- What VoVa knows about someone across conversations.
-- Facts, not transcripts: one row per profile, rewritten in place.
CREATE TABLE "vova_profile_memory" (
    "profile_id" UUID NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vova_profile_memory_pkey" PRIMARY KEY ("profile_id")
);

-- Cascade so deleting a profile takes its memory with it. The assistant must
-- not be able to recall someone who asked to be forgotten.
ALTER TABLE "vova_profile_memory"
    ADD CONSTRAINT "vova_profile_memory_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "profiles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
