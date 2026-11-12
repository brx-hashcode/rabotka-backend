-- When the call really began, for the compte rendu's « tenu de … à … ».
ALTER TABLE "interviews" ADD COLUMN "call_started_at" TIMESTAMPTZ;
