-- Per-profile bot pause.
--
-- While `bot_paused_until` is in the future the bot says nothing to this
-- profile: no reply to an inbound message, no scheduled reminder or nudge.
-- An admin who has taken a conversation over is not talked over by a robot.
--
-- A deadline rather than a boolean, so a forgotten toggle heals itself.
ALTER TABLE "profiles" ADD COLUMN "bot_paused_until" TIMESTAMPTZ;

-- Partial: the overwhelming majority of rows are NULL, and the only question
-- ever asked of this column is "is this one paused right now".
CREATE INDEX "idx_profile_bot_paused_until"
  ON "profiles" ("bot_paused_until")
  WHERE "bot_paused_until" IS NOT NULL;
