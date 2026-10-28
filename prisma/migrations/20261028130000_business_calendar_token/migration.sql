-- The private link of a business's interview calendar (subscribed in Google, Outlook, Apple).
ALTER TABLE "businesses" ADD COLUMN "calendar_token" TEXT;
CREATE UNIQUE INDEX "businesses_calendar_token_key" ON "businesses"("calendar_token");
