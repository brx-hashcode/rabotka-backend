-- Adds NEW_MESSAGE to the in-app notification feed.
--
-- Its own migration rather than a line in the messaging schema one: adding a
-- value to a Postgres enum cannot be rolled back, so it is worth being able to
-- point at the single commit that did it.
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'NEW_MESSAGE';
