-- Why an account was suspended, and when the profile last signed in.
--
-- The suspension reason was already collected by the admin UI and already sent
-- to the API, but it only ever reached the audit log — so the notification the
-- user received said nothing beyond "suspended", and the admin detail could not
-- show a reason without reading logs. Storing it on the profile makes it
-- answerable in one read.
--
-- `suspended_at` pairs with it: a reason with no date cannot distinguish the
-- current suspension from a previous one. Both are cleared when the account
-- leaves SUSPENDED.
--
-- `last_login_at` mirrors `users.last_login_at`, which admins have had since the
-- start. Profiles only had `first_login: boolean`, so nothing distinguished a
-- dormant account from an active one.
--
-- All three are nullable and unbackfilled: no historical login data exists, and
-- every suspension predating this migration has no recorded reason.
ALTER TABLE "profiles"
  ADD COLUMN "suspension_reason" TEXT,
  ADD COLUMN "suspended_at" TIMESTAMP(3),
  ADD COLUMN "last_login_at" TIMESTAMP(3);
