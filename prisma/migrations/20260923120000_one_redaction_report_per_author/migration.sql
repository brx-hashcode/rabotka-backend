-- One report per (message, author), because a report is a signal and not a
-- conversation.
--
-- The client only ever tracked "already reported" in component state, so
-- leaving the thread and coming back put the link back and the same author
-- could file the same report again, without limit. Each tap was a fresh row in
-- the moderation queue describing a message a human may already have judged.
--
-- COLLAPSE FIRST, then constrain: the unique index would fail on the duplicates
-- that already exist.

-- 1. Per (message, author), keep one: a report a human already looked at wins,
--    because dropping it would lose the verdict. Failing that, the oldest —
--    its note is the one written closest to the message.
DELETE FROM "redaction_reports" r
USING (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY message_id, reporter_id
           ORDER BY (reviewed_at IS NULL), created_at ASC
         ) AS keeper_id
  FROM "redaction_reports"
) ranked
WHERE r.id = ranked.id
  AND ranked.id <> ranked.keeper_id;

-- 2. The rule, enforced where it cannot be forgotten. The service now writes
--    with skipDuplicates, so a second tap is a no-op rather than an error.
CREATE UNIQUE INDEX "redaction_reports_message_reporter_key"
  ON "redaction_reports"("message_id", "reporter_id");

-- 3. Superseded: message_id is the leading column of the index above, so the
--    lookups that used this one are served by it.
DROP INDEX "idx_redaction_report_message";
