export const QDRANT_COLLECTION_PREFIX = 'rabotka_';

export const COLLECTIONS = {
  WORKERS: `${QDRANT_COLLECTION_PREFIX}workers`,
  JOBS: `${QDRANT_COLLECTION_PREFIX}jobs`,
  EMPLOYERS: `${QDRANT_COLLECTION_PREFIX}employers`,
} as const;
