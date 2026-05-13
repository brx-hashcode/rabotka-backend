-- Add rating fields to profiles
ALTER TABLE "profiles" ADD COLUMN "rating_avg" DOUBLE PRECISION;
ALTER TABLE "profiles" ADD COLUMN "rating_count" INTEGER NOT NULL DEFAULT 0;

-- Create ratings table
CREATE TABLE "ratings" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rater_id" UUID NOT NULL,
    "ratee_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- Unique: one rating per rater per assignment
CREATE UNIQUE INDEX "ratings_rater_id_assignment_id_key" ON "ratings"("rater_id", "assignment_id");

-- Indexes
CREATE INDEX "idx_rating_ratee" ON "ratings"("ratee_id");

-- Foreign keys
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_rater_id_fkey"
    FOREIGN KEY ("rater_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ratings" ADD CONSTRAINT "ratings_ratee_id_fkey"
    FOREIGN KEY ("ratee_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ratings" ADD CONSTRAINT "ratings_assignment_id_fkey"
    FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
