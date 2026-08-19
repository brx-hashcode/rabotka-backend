import { EmbeddingModel } from 'fastembed';
import { QDRANT_COLLECTION_PREFIX } from '../../qdrant/qdrant.config';

/**
 * The help corpus index.
 *
 * Deliberately a collection of its own rather than a sixth vector space in the
 * matching index: matching runs on English-only models tuned for skill and job
 * text (`BGE-small-en-v1.5`, 384d), and the corpus is French prose read by
 * people asking questions. A collection carries its own dimension and its own
 * model, so the two can be right about different things.
 *
 * The name MUST keep the prefix — `QdrantService.assertPrefix` refuses to touch
 * anything outside it, which is the guard that stops a bug here from reaching
 * the collections the marketplace depends on.
 */
export const HELP_DOCS_COLLECTION = `${QDRANT_COLLECTION_PREFIX}help_docs`;

/**
 * Multilingual, 1024 dimensions. Chosen over the matching stack's English-only
 * dense model for the obvious reason, and over a hosted embedding API because
 * retrieval then holds a network dependency on the reply path — the same
 * argument that keeps the geo dataset on disk.
 */
export const HELP_DENSE_MODEL = EmbeddingModel.MLE5Large;
export const HELP_DENSE_DIM = 1024;

/**
 * Bump when a payload field is added, removed, or changes meaning.
 *
 * Same discipline as `INDEX_SCHEMA_VERSION` in the matching index, and for the
 * same reason: Qdrant's `must` clauses EXCLUDE points that lack the key, so a
 * new filter over an un-rewritten back catalogue silently returns nothing
 * instead of erroring. Ingest stamps this, and a mismatch is what tells the
 * reindex to rewrite rather than skip.
 *
 * 1 → source, section, title, action_id, text, lang, needs_tool
 * 2 → adds `audience`, so an employer never retrieves a worker-only passage
 */
export const HELP_SCHEMA_VERSION = 2;

/** Payload keys worth a keyword index — anything a filter may key on. */
export const HELP_INDEXED_KEYS = [
  'source',
  'action_id',
  'lang',
  'audience',
  'schema_version',
] as const;

/**
 * Chunking. Articles are already short and single-purpose (one question per
 * file, under 400 words), so in practice a chunk is a section and most files
 * produce one or two. The cap only matters if an article outgrows the rule.
 */
export const CHUNK_MAX_WORDS = 350;
export const CHUNK_OVERLAP_RATIO = 0.15;

/** How many candidates each leg of the hybrid search contributes before fusion. */
export const PREFETCH_LIMIT = 32;
