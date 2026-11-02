-- Outlook was dropped: CVs come from Gmail mailboxes only. No Microsoft app was
-- ever configured, so no Outlook mailbox can exist; any stray row goes anyway.
DELETE FROM "business_mailboxes" WHERE "provider" = 'OUTLOOK';

-- Postgres cannot drop an enum value: swap the type for one without it.
ALTER TYPE "MailProvider" RENAME TO "MailProvider_old";
CREATE TYPE "MailProvider" AS ENUM ('GMAIL');
ALTER TABLE "business_mailboxes"
  ALTER COLUMN "provider" TYPE "MailProvider" USING ("provider"::text::"MailProvider");
DROP TYPE "MailProvider_old";
