-- CreateEnum
CREATE TYPE "InteractionActor" AS ENUM ('WORKER', 'EMPLOYER');

-- CreateEnum
CREATE TYPE "InteractionObject" AS ENUM ('JOB_OFFER', 'WORKER_PROFILE', 'EMPLOYER_PROFILE', 'PORTFOLIO', 'SEARCH', 'CATEGORY');

-- CreateEnum
CREATE TYPE "InteractionSource" AS ENUM ('WEB', 'BOT', 'MOBILE', 'SERVER', 'BACKFILL');

-- CreateEnum
CREATE TYPE "InteractionKind" AS ENUM ('IMPRESSION_BATCH', 'VIEW', 'PROFILE_VIEW', 'PORTFOLIO_VIEW', 'SEARCH', 'SEARCH_CLICK', 'SAVE', 'UNSAVE', 'APPLY', 'APPLY_CANCEL', 'ACCEPT', 'REJECT', 'COMPLETE', 'NO_SHOW', 'RATE_POSITIVE', 'RATE_NEGATIVE', 'CONTACT_UNLOCK', 'CONTACT_PAID', 'SKIP', 'DISLIKE', 'RECOMMENDATION_SERVED');

-- CreateEnum
CREATE TYPE "RejectionSource" AS ENUM ('EMPLOYER', 'AUTO_FILL');

-- CreateEnum
CREATE TYPE "RatingDirection" AS ENUM ('EMPLOYER_TO_WORKER', 'WORKER_TO_EMPLOYER');

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "accepted_at" TIMESTAMP(3),
ADD COLUMN     "rejected_at" TIMESTAMP(3),
ADD COLUMN     "rejection_source" "RejectionSource";

-- AlterTable
ALTER TABLE "ratings" ADD COLUMN     "direction" "RatingDirection";

-- CreateTable
CREATE TABLE "interaction_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID NOT NULL,
    "actor_type" "InteractionActor" NOT NULL,
    "kind" "InteractionKind" NOT NULL,
    "object_type" "InteractionObject" NOT NULL,
    "object_id" UUID,
    "category_id" UUID,
    "counterparty_id" UUID,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" "InteractionSource" NOT NULL,
    "surface" VARCHAR(40),
    "session_id" VARCHAR(64),
    "request_id" VARCHAR(64),
    "position" INTEGER,
    "dwell_ms" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "interaction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interaction_profiles" (
    "profile_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "positive_count" INTEGER NOT NULL DEFAULT 0,
    "last_event_at" TIMESTAMP(3),
    "category_affinity" JSONB NOT NULL DEFAULT '{}',
    "counterparty_affinity" JSONB NOT NULL DEFAULT '{}',
    "amount_band_affinity" JSONB NOT NULL DEFAULT '{}',
    "payment_flow_affinity" JSONB NOT NULL DEFAULT '{}',
    "negative_category_ids" UUID[],
    "distance_half_life_km" DOUBLE PRECISION,
    "vector_synced_at" TIMESTAMP(3),

    CONSTRAINT "interaction_profiles_pkey" PRIMARY KEY ("profile_id")
);

-- CreateIndex
CREATE INDEX "idx_ievent_actor_time" ON "interaction_events"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ievent_object_time" ON "interaction_events"("object_type", "object_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ievent_kind_time" ON "interaction_events"("kind", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ievent_request" ON "interaction_events"("request_id");

-- CreateIndex
CREATE INDEX "idx_iprofile_updated" ON "interaction_profiles"("updated_at");

-- AddForeignKey
ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_profiles" ADD CONSTRAINT "interaction_profiles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Additions Prisma cannot express ─────────────────────────────────────────

-- BRIN on the time column: interaction_events is append-only and time-ordered on
-- disk, so BRIN is a fraction of a btree's size and makes the retention prune
-- (DELETE WHERE occurred_at < …) cheap.
CREATE INDEX "idx_ievent_occurred_brin" ON "interaction_events" USING BRIN ("occurred_at");

-- Supports the collaborative-filtering co-occurrence query ("actors who applied
-- to X also applied to Y") without scanning the whole log.
CREATE INDEX "idx_ievent_apply_object" ON "interaction_events" ("object_id", "actor_id")
  WHERE "kind" = 'APPLY';

-- ── Backfill the new decision columns from what we can still infer ──────────

-- Accept timestamp: the assignment row is created in the same transaction as the
-- accept, so its created_at is the only faithful proxy available.
UPDATE "applications" a
SET "accepted_at" = s."created_at"
FROM "assignments" s
WHERE s."application_id" = a."id"
  AND a."accepted_at" IS NULL
  AND a."status" IN ('WAITING_PAYMENT', 'ACCEPTED', 'STARTED', 'END');

-- Rejections: attribute to AUTO_FILL when the offer had already closed, otherwise
-- to the employer. Historical rows have no better evidence than this, and getting
-- it wrong in the pessimistic direction is what poisons category preferences —
-- so anything ambiguous is treated as AUTO_FILL, never as an employer decision.
UPDATE "applications" a
SET "rejected_at" = a."updated_at",
    "rejection_source" = CASE
      WHEN jo."status" IN ('FILLED', 'IN_PROGRESS', 'COMPLETED') THEN 'AUTO_FILL'::"RejectionSource"
      ELSE 'EMPLOYER'::"RejectionSource"
    END
FROM "job_offers" jo
WHERE jo."id" = a."job_offer_id"
  AND a."status" = 'REJECTED'
  AND a."rejected_at" IS NULL;

-- Rating direction: derived by comparing the rater against the assignment's
-- worker. This is exactly the join the read path had to repeat every time.
UPDATE "ratings" r
SET "direction" = CASE
      WHEN s."worker_id" = r."rater_id" THEN 'WORKER_TO_EMPLOYER'::"RatingDirection"
      ELSE 'EMPLOYER_TO_WORKER'::"RatingDirection"
    END
FROM "assignments" s
WHERE s."id" = r."assignment_id"
  AND r."direction" IS NULL;
