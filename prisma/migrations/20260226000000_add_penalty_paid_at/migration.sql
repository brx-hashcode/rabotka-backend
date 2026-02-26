-- Add paid_at column to penalties to track whether a penalty has been paid
ALTER TABLE "penalties" ADD COLUMN "paid_at" TIMESTAMP(3);

