import { createHash } from 'node:crypto';
import { CHUNK_MAX_WORDS, CHUNK_OVERLAP_RATIO } from './help-docs.config';

/**
 * Who an article applies to.
 *
 * Not decoration: a worker has «Mes réalisations», an employer does not — the
 * client hides the whole row behind `{!isEmployer && …}`. Retrieving a
 * worker-only passage for an employer produces a confident answer about a
 * screen they will never find, which is worse than no answer.
 */
export type CorpusAudience = 'worker' | 'employer' | 'all';

export interface CorpusDoc {
  /** Stable file-level id, from front matter. Also the delete key on re-ingest. */
  source: string;
  title: string;
  /** Canonical button id a retrieved chunk can suggest. */
  actionId: string | null;
  lang: string;
  audience: CorpusAudience;
  body: string;
}

export interface CorpusChunk {
  /** Deterministic — the same article re-ingested overwrites, never duplicates. */
  id: string;
  source: string;
  title: string;
  section: string;
  actionId: string | null;
  lang: string;
  audience: CorpusAudience;
  text: string;
  /**
   * True when the chunk carries a `{{tool:…}}` placeholder, i.e. it cannot be
   * answered without calling that tool first. The agent reads this rather than
   * inferring it, so "never quote a fee from memory" has a mechanism behind it
   * and not only a sentence in a prompt.
   */
  needsTool: string | null;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const TOOL_PLACEHOLDER = /\{\{tool:([a-z_]+)\}\}/;

/**
 * Parses one corpus file.
 *
 * Front matter is a flat `key: value` block — deliberately not YAML. The corpus
 * needs four scalars and nothing else, and a parser dependency for that would
 * be a supply-chain risk bought for no capability.
 */
export function parseDoc(raw: string, fallbackSource: string): CorpusDoc {
  const match = FRONT_MATTER.exec(raw);
  const meta: Record<string, string> = {};
  let body = raw;

  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) meta[key] = value;
    }
  }

  return {
    source: meta.id || fallbackSource,
    title: meta.title || fallbackSource,
    actionId: meta.action_id || null,
    lang: meta.lang || 'fr',
    audience: parseAudience(meta.audience),
    body: body.trim(),
  };
}

function parseAudience(raw: string | undefined): CorpusAudience {
  return raw === 'worker' || raw === 'employer' ? raw : 'all';
}

/**
 * Splits a document into retrievable chunks, one per `##` section.
 *
 * The title is prepended to every chunk's text. A section reading "Comment ça
 * marche" is meaningless on its own once it is a vector among three hundred
 * others — the article it belongs to is most of its meaning, and embedding it
 * without that is how a corpus retrieves the right *shape* of answer about the
 * wrong subject.
 */
export function chunkDoc(doc: CorpusDoc): CorpusChunk[] {
  const sections = splitSections(doc.body, doc.title);
  const chunks: CorpusChunk[] = [];

  for (const section of sections) {
    const parts = splitLongText(section.text);
    parts.forEach((text, partIndex) => {
      const composed = `${doc.title}\n\n${section.heading}\n${text}`.trim();
      chunks.push({
        id: chunkId(doc.source, section.heading, partIndex),
        source: doc.source,
        title: doc.title,
        section: section.heading,
        actionId: doc.actionId,
        lang: doc.lang,
        audience: doc.audience,
        text: composed,
        needsTool: TOOL_PLACEHOLDER.exec(composed)?.[1] ?? null,
      });
    });
  }

  return chunks;
}

interface Section {
  heading: string;
  text: string;
}

function splitSections(body: string, title: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let heading = title;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      heading = h2[1].trim();
      continue;
    }
    // A leading `# Title` duplicates the front matter; drop it rather than
    // embedding the title twice in the same vector.
    if (/^#\s+/.test(line)) continue;
    buffer.push(line);
  }
  flush();

  return sections;
}

/**
 * Only splits a section that outgrew the cap. Overlap exists so a sentence that
 * straddles the boundary is retrievable from both halves.
 */
function splitLongText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= CHUNK_MAX_WORDS) return [text];

  const overlap = Math.floor(CHUNK_MAX_WORDS * CHUNK_OVERLAP_RATIO);
  const stride = CHUNK_MAX_WORDS - overlap;
  const parts: string[] = [];

  for (let start = 0; start < words.length; start += stride) {
    parts.push(words.slice(start, start + CHUNK_MAX_WORDS).join(' '));
    if (start + CHUNK_MAX_WORDS >= words.length) break;
  }

  return parts;
}

/**
 * A UUID derived from the chunk's identity, so re-ingesting an unchanged
 * article is a no-op upsert rather than a duplicate. Qdrant only accepts a UUID
 * or an unsigned integer as a point id, which is why the digest is reshaped
 * rather than used raw.
 */
export function chunkId(
  source: string,
  section: string,
  partIndex: number,
): string {
  const digest = createHash('sha256')
    .update(`${source}#${section}#${partIndex}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');
}
