-- Repeating events.
--
-- Each occurrence is a real `events` row tagged with `series_id`, rather than a
-- rule expanded on the fly at read time. The admin keys every rendered event on
-- the numeric `events.id` — React keys, the month-view lane map, the drag/drop
-- payload, PATCH/DELETE /admin/event/:id — and a virtual occurrence has no such
-- id to hand back. With real rows, "edit only this occurrence" is the UPDATE
-- that already exists.
--
-- The rule itself lives in one place instead of being copied onto every
-- occurrence, so extending an open-ended series is one row update plus the new
-- inserts.
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

CREATE TABLE "event_series" (
  "id"         UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3)          NOT NULL,
  "frequency"  "RecurrenceFrequency" NOT NULL,
  -- The first occurrence. Later ones are computed from this, not from their
  -- predecessor, so a monthly series anchored on the 31st keeps aiming at the
  -- 31st instead of drifting forward off a clamped February.
  "anchor_start" TIMESTAMP(3) NOT NULL,
  "anchor_end"   TIMESTAMP(3) NOT NULL,
  -- End condition: at most one of these is set. Both NULL means open-ended.
  "until" TIMESTAMP(3),
  "count" INTEGER,
  -- How far ahead the occurrence rows have actually been written. An
  -- open-ended series is generated a year out and topped up when someone
  -- browses past it.
  "materialised_until" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_series_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_series_end_condition" CHECK ("until" IS NULL OR "count" IS NULL),
  CONSTRAINT "event_series_count_positive" CHECK ("count" IS NULL OR "count" > 0)
);

CREATE INDEX "idx_event_series_materialised_until" ON "event_series" ("materialised_until");

-- Both columns nullable with no backfill: every event that already exists stays
-- a one-off and reads back as `recurrence: null`.
ALTER TABLE "events" ADD COLUMN "series_id" UUID;
ALTER TABLE "events" ADD COLUMN "occurrence_index" INTEGER;

ALTER TABLE "events"
  ADD CONSTRAINT "events_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "event_series"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Every scoped operation is "this series, from this date onwards".
CREATE INDEX "idx_event_series_start" ON "events" ("series_id", "start_date");
