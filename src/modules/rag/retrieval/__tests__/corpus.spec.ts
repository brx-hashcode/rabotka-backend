import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { chunkDoc, parseDoc, type CorpusChunk } from '../chunker';

const CORPUS_DIR = path.join(__dirname, '..', 'corpus');

const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md'));
const docs = files.map((file) => ({
  file,
  doc: parseDoc(
    readFileSync(path.join(CORPUS_DIR, file), 'utf8'),
    path.basename(file, '.md'),
  ),
}));

describe('help corpus', () => {
  it('is not empty', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(docs)('$file has complete front matter', ({ file, doc }) => {
    expect(doc.source).toBe(path.basename(file, '.md'));
    expect(doc.title.length).toBeGreaterThan(5);
    expect(doc.lang).toBe('fr');
    expect(doc.actionId).toMatch(/^action:[a-z_]+$/);
    // Explicit on every article: an unset audience silently becomes `all`, and
    // a worker-only screen shown to an employer is a confident wrong answer.
    expect(['worker', 'employer', 'all']).toContain(doc.audience);
  });

  // The client hides « Mes réalisations » behind `{!isEmployer && …}`.
  it('scopes the réalisations articles to the role that has the screen', () => {
    const byId = new Map(docs.map(({ doc }) => [doc.source, doc]));
    expect(byId.get('portfolio')?.audience).toBe('worker');
    expect(byId.get('employeur-pas-de-realisations')?.audience).toBe(
      'employer',
    );
  });

  // The screen is called « Mes réalisations », not « Portfolio ».
  it('names screens the way the application names them', () => {
    const portfolio = byIdOrFail('portfolio');
    expect(portfolio.body).toContain('Mes réalisations');
    expect(portfolio.body).not.toMatch(/section portfolio/i);
  });

  function byIdOrFail(id: string) {
    const found = docs.find(({ doc }) => doc.source === id);
    if (!found) throw new Error(`missing corpus article: ${id}`);
    return found.doc;
  }

  it.each(docs)('$file stays under 400 words', ({ doc }) => {
    expect(doc.body.split(/\s+/).filter(Boolean).length).toBeLessThan(400);
  });

  /**
   * The invariant this file exists for.
   *
   * Fees, credits and penalties live in `SystemConfig` and an admin changes
   * them without a deploy. An article that hardcodes one is wrong the moment it
   * is edited, and wrong *silently* — the assistant would quote it confidently.
   * So the corpus may not contain a money figure at all: it points at the tool
   * instead.
   */
  it.each(docs)('$file quotes no amount of money', ({ doc }) => {
    expect(doc.body).not.toMatch(/\d[\d\s.,]*\s*(FCFA|F\s?CFA|XAF|francs?)/i);
    expect(doc.body).not.toMatch(/(FCFA|F\s?CFA|XAF)\s*\d/i);
  });

  /** Same reasoning for delays: KYC review is a human queue with no SLA. */
  it.each(docs)('$file promises no delay', ({ doc }) => {
    expect(doc.body).not.toMatch(
      /sous\s+\d+\s*(heures?|jours?|minutes?)|dans\s+les\s+\d+\s*(heures?|jours?)/i,
    );
  });

  it('references only tools that the agent will expose', () => {
    const known = new Set([
      'etat_du_profil',
      'mes_candidatures',
      'etat_deblocage',
      'solde_credit',
      'tarif_deblocage',
      'mes_penalites',
    ]);
    for (const { file, doc } of docs) {
      for (const [, tool] of doc.body.matchAll(/\{\{tool:([a-z_]+)\}\}/g)) {
        expect([file, tool]).toEqual([file, expect.stringMatching(/.*/)]);
        expect(known.has(tool)).toBe(true);
      }
    }
  });

  it('chunks cleanly, with unique ids across the whole corpus', () => {
    const all: CorpusChunk[] = docs.flatMap(({ doc }) => chunkDoc(doc));
    expect(all.length).toBeGreaterThanOrEqual(docs.length);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const chunk of all) {
      expect(chunk.text.trim().length).toBeGreaterThan(40);
    }
  });

  // Rabotka takes no commission and never handles the wage. A model said
  // «tu es payé·e via la plateforme», which is false and invites a dispute.
  it('never suggests that Rabotka pays the wage', () => {
    for (const { file, doc } of docs) {
      expect([file, doc.body]).not.toEqual([
        file,
        expect.stringMatching(
          /pay[ée]s?\s+(par|via)\s+(la\s+)?(plateforme|rabotka)/i,
        ),
      ]);
    }
  });

  it('states plainly that the wage is settled between the two people', () => {
    const intro = docs.find(({ doc }) => doc.source === 'c-est-quoi-rabotka');
    expect(intro?.doc.body).toMatch(/ne vous paie pas|aucune commission/i);
  });

  it('covers the questions support is actually asked', () => {
    const sources = new Set(docs.map(({ doc }) => doc.source));
    for (const required of [
      'c-est-quoi-rabotka',
      'verification-kyc',
      'deblocage-contact',
      'deblocage-non-paye',
      'numeros-masques',
      'penalites',
      'score-fiabilite',
      'securite-garde-enfants',
      'litige-reclamation',
      'contacter-support',
    ]) {
      expect(sources.has(required)).toBe(true);
    }
  });
});
