-- Sandbox applications.
--
-- A sandbox app authenticates only the two hardcoded Rabotka sandbox users,
-- with a fixed OTP and no `profiles` row behind them, so a partner can build
-- their integration without a real account and without a real WhatsApp message.
--
-- The flag is the only gate; there is deliberately no environment check, so a
-- sandbox app works in production too. Set once at registration and never
-- updated — see the note on the column in schema.prisma for why.
--
-- No index: this is never a query predicate. It is read off a row that has
-- already been fetched by `client_id` or by `id`.
--
-- DEFAULT false backfills every existing row correctly: every application
-- registered before this migration is a real one.
ALTER TABLE "oauth_apps"
  ADD COLUMN "is_sandbox" BOOLEAN NOT NULL DEFAULT false;
