-- What a business shows of itself on its careers page.
ALTER TABLE "businesses" ADD COLUMN "cover_url" TEXT;
ALTER TABLE "businesses" ADD COLUMN "photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "businesses" ADD COLUMN "benefits" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
