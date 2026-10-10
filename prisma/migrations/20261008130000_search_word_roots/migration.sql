-- Word-root matching for the forgiving search (src/common/queries/text-search.ts):
-- « developpeur » finds « developer », « development » and the misspelt
-- « devepment »; « plombier » finds « plomberie ». Trigram similarity alone
-- cannot: a word family differs too much at the end (« plombier » / « plomberie »
-- is 0.36).
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- The root of an already folded word (unaccent + lower): a French or English
-- ending stripped, never below 4 letters, then a doubled last letter collapsed
-- (« developp » → « develop »).
CREATE OR REPLACE FUNCTION search_stem(w text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
    regexp_replace(
      w,
      '^(.{4,}?)(ements|ement|ments|ment|ations|ation|euses|euse|eurs|eur|rices|rice|ieres|iere|iers|ier|iennes|ienne|iens|ien|eries|erie|ages|age|ings|ing|ions|ion|iques|ique|ites|ite|istes|iste|ures|ure|ers|er|es|e|s)$',
      '\1'
    ),
    '(.)\1$',
    '\1'
  )
$$;

-- Two roots of the same word: equal, one a prefix of the other
-- (« mecanic » / « mecan »), or a typo apart. Same first two letters always
-- (« develop » is not « envelop »); two edits only when a letter is missing or
-- extra (« devep » for « develop »), not for two swapped letters
-- (« electric » is not « electron »).
CREATE OR REPLACE FUNCTION search_roots_match(a text, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT length(a) >= 4 AND length(b) >= 4 AND left(a, 2) = left(b, 2) AND (
    a = b
    OR (length(b) >= 5 AND a LIKE b || '%')
    OR (length(a) >= 5 AND b LIKE a || '%')
    OR levenshtein(a, b) <= CASE
      WHEN greatest(length(a), length(b)) >= 7 AND length(a) <> length(b) THEN 2
      WHEN greatest(length(a), length(b)) >= 5 THEN 1
      ELSE 0
    END
  )
$$;

-- Whether a folded search word shares its root with any word of a folded text.
CREATE OR REPLACE FUNCTION search_root_in(token text, haystack text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM regexp_split_to_table(haystack, '[^[:alnum:]]+') AS w
    WHERE search_roots_match(search_stem(token), search_stem(w))
  )
$$;
