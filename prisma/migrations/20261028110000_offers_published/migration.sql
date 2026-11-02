-- A plan's offer limit is now per period: the offers published during it, from 0.
ALTER TABLE "business_subscriptions" ADD COLUMN "offers_published" INTEGER NOT NULL DEFAULT 0;
