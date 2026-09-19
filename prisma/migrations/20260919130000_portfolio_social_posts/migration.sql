-- A publication becomes text, images, or both — and loses its title.
--
-- The title is folded into the body FIRST and only then dropped. Run in this
-- order or every title ever written is gone: there is no second pass that can
-- recover a column that has already been removed.
--
-- A title with an empty description becomes the whole body; otherwise it
-- becomes the first line, which is how the text reads as a caption anyway.
UPDATE "portfolio_items"
SET "description" = CASE
  WHEN btrim("description") = '' THEN "title"
  ELSE "title" || E'\n\n' || "description"
END
WHERE btrim("title") <> '';

-- AlterTable
ALTER TABLE "portfolio_items" DROP COLUMN "title";

-- Null for an images-only publication. "Description OR images" cannot be a
-- CHECK — the images are rows in another table — so the service enforces it.
ALTER TABLE "portfolio_items" ALTER COLUMN "description" DROP NOT NULL;
