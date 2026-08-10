-- Feedback about Rabotka, collected through a WhatsApp Flow.
--
-- Deliberately not folded into `ratings`: that table is rater -> ratee on an
-- assignment and every row needs a counterparty. This is a product survey with
-- no other party, and forcing it into the same shape would mean nullable
-- ratee_id and assignment_id on a table where their absence is currently a bug.
CREATE TABLE "feedback" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "profile_id" UUID         NOT NULL,
  "score"      INTEGER      NOT NULL,
  "comment"    TEXT,
  "source"     TEXT         NOT NULL DEFAULT 'whatsapp_flow',
  -- Echoed back by the Flow submission. UNIQUE so a webhook retry, or a form
  -- submitted twice, cannot double-count.
  "flow_token" TEXT,
  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feedback_score_range" CHECK ("score" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "feedback_flow_token_key" ON "feedback" ("flow_token");
CREATE INDEX "idx_feedback_profile" ON "feedback" ("profile_id");
CREATE INDEX "idx_feedback_created_at" ON "feedback" ("created_at");

ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
