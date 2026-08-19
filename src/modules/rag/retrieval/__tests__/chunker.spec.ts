import { chunkDoc, chunkId, parseDoc } from '../chunker';

const DOC = `---
id: deblocage-contact
title: Le déblocage de contact
action_id: action:deblocage
lang: fr
---

## Quand ça arrive

Après qu'une candidature a été acceptée.

## Combien ça coûte

Je vais chercher le montant. {{tool:tarif_deblocage}}
`;

describe('parseDoc', () => {
  it('reads the front matter', () => {
    const doc = parseDoc(DOC, 'fallback');
    expect(doc.source).toBe('deblocage-contact');
    expect(doc.title).toBe('Le déblocage de contact');
    expect(doc.actionId).toBe('action:deblocage');
    expect(doc.lang).toBe('fr');
  });

  it('falls back to the filename when there is no id', () => {
    expect(parseDoc('## Section\ntexte', 'mon-article').source).toBe(
      'mon-article',
    );
  });
});

describe('chunkDoc', () => {
  const chunks = chunkDoc(parseDoc(DOC, 'x'));

  it('produces one chunk per section', () => {
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.section)).toEqual([
      'Quand ça arrive',
      'Combien ça coûte',
    ]);
  });

  // A section heading is nearly meaningless as a vector on its own; the article
  // it belongs to is most of its meaning.
  it('prepends the article title to every chunk', () => {
    for (const chunk of chunks) {
      expect(chunk.text).toContain('Le déblocage de contact');
    }
  });

  it('flags the chunk that cannot be answered without a tool', () => {
    expect(chunks[0].needsTool).toBeNull();
    expect(chunks[1].needsTool).toBe('tarif_deblocage');
  });

  it('carries the action id onto every chunk, so a hit can suggest its button', () => {
    expect(chunks.every((c) => c.actionId === 'action:deblocage')).toBe(true);
  });

  it('treats a document with no headings as a single chunk', () => {
    const single = chunkDoc(
      parseDoc('---\nid: a\ntitle: T\n---\n\ndu texte', 'a'),
    );
    expect(single).toHaveLength(1);
    expect(single[0].section).toBe('T');
  });

  it('splits a section that outgrows the cap, with overlap', () => {
    const long = `---\nid: long\ntitle: T\n---\n\n## S\n\n${'mot '.repeat(900)}`;
    const parts = chunkDoc(parseDoc(long, 'long'));
    expect(parts.length).toBeGreaterThan(1);
    expect(new Set(parts.map((p) => p.id)).size).toBe(parts.length);
  });
});

describe('chunkId', () => {
  // Re-ingesting an unchanged article must overwrite, never duplicate.
  it('is deterministic', () => {
    expect(chunkId('a', 'S', 0)).toBe(chunkId('a', 'S', 0));
  });

  it('differs per article, per section and per part', () => {
    const ids = new Set([
      chunkId('a', 'S', 0),
      chunkId('b', 'S', 0),
      chunkId('a', 'T', 0),
      chunkId('a', 'S', 1),
    ]);
    expect(ids.size).toBe(4);
  });

  it('is a UUID, which is what Qdrant accepts as a point id', () => {
    expect(chunkId('a', 'S', 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
