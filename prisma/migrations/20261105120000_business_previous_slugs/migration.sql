-- A business's slugs before a rename: they still lead to its careers page.
ALTER TABLE "businesses" ADD COLUMN     "previous_slugs" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "idx_business_previous_slugs" ON "businesses" USING GIN ("previous_slugs");

-- A business renamed before this kept the slug of its first name. It gets the
-- slug of its current name (same rule as careers-slug.ts, and as
-- 20261030150000_business_public_slug); the old one moves to previous_slugs.
DO $$
DECLARE
  b RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR b IN SELECT id, name, public_slug FROM "businesses" ORDER BY created_at, id LOOP
    base := COALESCE(
      NULLIF(
        trim(both '-' from left(regexp_replace(
          lower(translate(b.name, 'àâäáãåéèêëîïíìôöóòõùûüúçñÀÂÄÁÃÅÉÈÊËÎÏÍÌÔÖÓÒÕÙÛÜÚÇÑ', 'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN')),
          '[^a-z0-9]+', '-', 'g'
        ), 60)),
        ''
      ),
      'entreprise'
    );
    -- Already made from its name: `kamoa`, or `kamoa-3`.
    CONTINUE WHEN b.public_slug IS NOT NULL
      AND (b.public_slug = base OR b.public_slug ~ ('^' || base || '-[0-9]+$'));

    candidate := base;
    n := 1;
    WHILE candidate IN ('sitemap', 'feed') OR EXISTS (
      SELECT 1 FROM "businesses" o
      WHERE o.id <> b.id
        AND (o.public_slug = candidate OR candidate = ANY (o.previous_slugs))
    ) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;

    UPDATE "businesses"
    SET "public_slug" = candidate,
        "previous_slugs" = CASE
          WHEN b.public_slug IS NULL THEN "previous_slugs"
          ELSE array_append(array_remove("previous_slugs", candidate), b.public_slug)
        END
    WHERE id = b.id;
  END LOOP;
END $$;
