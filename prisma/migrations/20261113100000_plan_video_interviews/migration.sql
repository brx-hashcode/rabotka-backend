-- « Visio dans Rabotka » becomes a plan service, off until an admin turns it on.
ALTER TABLE "business_plans" ADD COLUMN "video_interviews" BOOLEAN NOT NULL DEFAULT false;
