-- The business's public careers page: /carrieres/<public_slug>.
ALTER TABLE "businesses" ADD COLUMN "public_slug" TEXT;

-- Same rule as careers-slug.ts; same-named businesses get -2, -3, oldest first.
WITH base AS (
  SELECT
    id,
    created_at,
    COALESCE(
      NULLIF(
        trim(both '-' from left(regexp_replace(
          lower(translate(name, 'àâäáãåéèêëîïíìôöóòõùûüúçñÀÂÄÁÃÅÉÈÊËÎÏÍÌÔÖÓÒÕÙÛÜÚÇÑ', 'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN')),
          '[^a-z0-9]+', '-', 'g'
        ), 60)),
        ''
      ),
      'entreprise'
    ) AS slug
  FROM "businesses"
),
numbered AS (
  SELECT id, slug, row_number() OVER (PARTITION BY slug ORDER BY created_at, id) AS n
  FROM base
)
UPDATE "businesses" b
SET "public_slug" = CASE WHEN numbered.n = 1 THEN numbered.slug ELSE numbered.slug || '-' || numbered.n END
FROM numbered
WHERE b.id = numbered.id;

CREATE UNIQUE INDEX "businesses_public_slug_key" ON "businesses"("public_slug");
