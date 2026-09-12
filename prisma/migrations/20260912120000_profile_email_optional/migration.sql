-- AlterTable
--
-- Rabotka onboards the informal sector, where most workers have a phone but no
-- email address. Requiring one did not produce email addresses; it produced
-- invented ones that bounce. `phone` is the real identity — onboarding is
-- WhatsApp-first and signup proves the number — so email drops to optional.
--
-- Purely additive: every existing row holds a real address (nothing in the
-- codebase has ever generated a synthetic or placeholder one), so no account is
-- affected and there is nothing to backfill.
ALTER TABLE "profiles" ALTER COLUMN "email" DROP NOT NULL;

-- One representation of "no email", and the load-bearing half of this
-- migration. '' passes a `!= NULL` check but is not an address, so leaving it
-- would force every guard in the codebase to test truthiness AND null.
--
-- More pressingly: the column is UNIQUE, and Postgres treats '' as an ordinary
-- value while allowing any number of NULLs. Two emailless profiles holding ''
-- cannot coexist — which is precisely the situation this feature creates, at
-- scale, from the second emailless signup onward.
UPDATE "profiles" SET "email" = NULL WHERE trim("email") = '';

-- `profiles_email_key` (UNIQUE) and `idx_profile_email` are both unchanged:
-- Postgres permits many NULLs in a unique index, so neither needs touching.
