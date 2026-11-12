-- « Terminer l'entretien »: the call is over, whatever its scheduled time.
ALTER TABLE "interviews" ADD COLUMN "ended_at" TIMESTAMPTZ;
