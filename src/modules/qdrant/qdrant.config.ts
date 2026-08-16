const env = process.env.IS_PROD === 'true' ? 'prod' : 'dev';
export const QDRANT_COLLECTION_PREFIX = `rabotka_${env}_`;

export const COLLECTIONS = {
  WORKERS: `${QDRANT_COLLECTION_PREFIX}workers`,
  JOBS: `${QDRANT_COLLECTION_PREFIX}jobs`,
  EMPLOYERS: `${QDRANT_COLLECTION_PREFIX}employers`,
  SIGNALS: `${QDRANT_COLLECTION_PREFIX}signals`,
  USER_INTERESTS: `${QDRANT_COLLECTION_PREFIX}user_interests`,
} as const;

/**
 * Shape of the payloads written into the collections above. **Bump this whenever
 * a payload gains, loses or changes the meaning of a field.**
 *
 * Points are only ever rewritten when something asks for it, so adding a field
 * leaves every existing point without it — and a Qdrant `must` clause on a key a
 * point does not have EXCLUDES that point. A new filter would therefore silently
 * empty retrieval for the entire back catalogue rather than erroring. Comparing
 * this against `matching.index_schema_version` is what makes `reindexPending`
 * rewrite the old points, and what stops new filters being applied to an index
 * that has not caught up yet.
 *
 * 1 → original payload
 * 2 → adds `countryCode` / `city` to worker, employer and job payloads
 */
export const INDEX_SCHEMA_VERSION = 2;
