import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';

/**
 * A team's notes and opinions on a candidate are never shown to the candidate.
 * The surest way to keep it so: nothing outside this module reads them — not
 * an application payload, not a careers page, not an e-mail. A new reader
 * fails here and has to be looked at.
 */
const SRC = path.join(__dirname, '..', '..', '..', '..');
const ALLOWED = [/^modules\/business\/candidate-notes\//];
const READERS =
  /\b(candidateNote|candidateOpinion|team_notes|team_opinions|candidate_notes|candidate_opinions)\b/;

describe('candidate notes stay private', () => {
  it('are read only by the candidate-notes module', () => {
    const files = globSync('**/*.ts', {
      cwd: SRC,
      ignore: ['**/__tests__/**', '**/*.spec.ts'],
    });
    // The scan reads the real tree, not an empty folder.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(
      'modules/business/candidate-notes/candidate-notes.service.ts',
    );
    const offenders = files
      .filter((f) => !ALLOWED.some((a) => a.test(f)))
      .filter((f) => READERS.test(readFileSync(path.join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
