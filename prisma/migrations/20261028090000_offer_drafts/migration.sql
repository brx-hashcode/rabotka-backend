-- « Rédiger avec l'IA »: offers the AI writes per period, set per plan; counted per period.
ALTER TABLE "business_plans" ADD COLUMN "offer_drafts_per_period" INTEGER DEFAULT 20;
ALTER TABLE "business_subscriptions" ADD COLUMN "offer_drafts_used" INTEGER NOT NULL DEFAULT 0;
