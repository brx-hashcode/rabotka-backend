-- One conversation per (worker, employer) pair, like one chat per contact.
--
-- Until now a pair could have one thread per application plus one direct
-- thread, so the same person appeared several times in the list. The
-- application becomes the thread's CONTEXT (the most recent one, shown in the
-- header) rather than its key.
--
-- MERGE FIRST, then re-key: the new unique index would fail on the duplicates
-- that already exist. Messages are MOVED to the surviving thread, never
-- deleted — they are evidence for claims and for reviewing redactions, and
-- their redactions and reports follow them because those hang off the
-- message, not the conversation.

-- 1. Pick one survivor per pair: the one with the latest message, then the
--    oldest. The others are the losers.
CREATE TEMP TABLE conversation_merge AS
SELECT id AS loser_id, keeper_id
FROM (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY worker_id, employer_id
           ORDER BY last_message_at DESC NULLS LAST, created_at ASC
         ) AS keeper_id
  FROM "profile_conversations"
) ranked
WHERE id <> keeper_id;

-- 2. Move every message onto the survivor.
UPDATE "profile_messages" m
SET "conversation_id" = cm.keeper_id
FROM conversation_merge cm
WHERE m."conversation_id" = cm.loser_id;

-- 3. Fold what the losers knew into the survivor, before they go: the latest
--    activity, the latest read marks, and an application to show as context
--    when the survivor had none. Hidden marks keep the survivor's: a side that
--    cleared the thread it was looking at should not see the others reappear
--    whole.
CREATE TEMP TABLE conversation_fold AS
SELECT cm.keeper_id,
       MAX(l."last_message_at")       AS last_message_at,
       MAX(l."worker_last_read_at")   AS worker_last_read_at,
       MAX(l."employer_last_read_at") AS employer_last_read_at,
       (ARRAY_AGG(l."application_id" ORDER BY l."created_at" DESC)
          FILTER (WHERE l."application_id" IS NOT NULL))[1] AS application_id
FROM conversation_merge cm
JOIN "profile_conversations" l ON l.id = cm.loser_id
GROUP BY cm.keeper_id;

-- 4. The losers are empty now. Deleted — no message goes with them.
DELETE FROM "profile_conversations"
WHERE id IN (SELECT loser_id FROM conversation_merge);

-- 5. Only now can the survivor take a loser's application: while the loser
--    existed, application_id was still unique.
UPDATE "profile_conversations" k
SET "last_message_at"       = GREATEST(k."last_message_at", f.last_message_at),
    "worker_last_read_at"   = GREATEST(k."worker_last_read_at", f.worker_last_read_at),
    "employer_last_read_at" = GREATEST(k."employer_last_read_at", f.employer_last_read_at),
    "application_id"        = COALESCE(k."application_id", f.application_id)
FROM conversation_fold f
WHERE k.id = f.keeper_id;

-- 6. Re-key. application_id stops being unique — a pair can have many
--    applications, the thread remembers the latest — and the pair becomes the
--    key. The partial "direct pair" index is superseded by the full one.
DROP INDEX "profile_conversations_application_id_key";
DROP INDEX "profile_conversations_direct_pair";
CREATE INDEX "idx_profile_conversation_application" ON "profile_conversations"("application_id");
CREATE UNIQUE INDEX "profile_conversations_pair_key" ON "profile_conversations"("worker_id", "employer_id");
