-- One model per grid: two models do not mark alike (22 points apart, measured
-- 2026-11-25), so a candidate's score must not depend on which one answered.
ALTER TABLE "cv_grids" ADD COLUMN "model" TEXT;
