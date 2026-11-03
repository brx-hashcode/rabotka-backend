-- CV forwarding was dropped (Cloudflare Email Routing has no catch-all on a
-- subdomain); CVs come in through the Google and Outlook connections only.
DROP TABLE IF EXISTS "business_inbox_mails";
DROP INDEX IF EXISTS "businesses_inbox_token_key";
ALTER TABLE "businesses" DROP COLUMN IF EXISTS "inbox_token";
