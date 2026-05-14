const env = process.env.IS_PROD === 'true' ? 'prod' : 'dev';
export const QDRANT_COLLECTION_PREFIX = `rabotka_${env}_`;

export const COLLECTIONS = {
  WORKERS: `${QDRANT_COLLECTION_PREFIX}workers`,
  JOBS: `${QDRANT_COLLECTION_PREFIX}jobs`,
  EMPLOYERS: `${QDRANT_COLLECTION_PREFIX}employers`,
  SIGNALS: `${QDRANT_COLLECTION_PREFIX}signals`,
  USER_INTERESTS: `${QDRANT_COLLECTION_PREFIX}user_interests`,
} as const;
