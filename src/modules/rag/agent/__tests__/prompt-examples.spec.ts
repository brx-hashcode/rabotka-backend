import * as fs from 'node:fs';
import * as path from 'node:path';

const PROMPTS = fs.readFileSync(
  path.join('src', 'modules', 'rag', 'agent', 'prompts.ts'),
  'utf8',
);

/** Prompt lines only — the comments above them explain the history. */
const instructions = PROMPTS.split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/**
 * A FORMATTING EXAMPLE MUST NOT BE A FACT.
 *
 * The style example used to be « *Sans commission* — le prix se règle entre
 * vous, Rabotka ne prend rien. » The model quoted it as an ANSWER in two
 * separate conversations and built on it — "sans frais de déblocage si elle est
 * déjà vérifiée" — which is false, and about money.
 *
 * The corpus is right and complete: no commission ON WHAT YOU EARN, but
 * unlocking a contact is paid. The example dropped the second half, and an
 * example is the one thing in a prompt that gets copied verbatim.
 */
describe('the prompt’s formatting examples', () => {
  it.each(['commission', 'FCFA', 'gratuit'])(
    'never demonstrates style with a claim about %s',
    (word) => {
      const lines = instructions
        .split('\n')
        .filter((line) => line.includes('structure en lignes courtes'));

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain(word);
    },
  );

  it('keeps the pricing statement where it belongs, in the corpus', () => {
    // Stated there in full: no commission on earnings, AND unlocking is paid.
    const corpus = fs.readFileSync(
      path.join(
        'src',
        'modules',
        'rag',
        'retrieval',
        'corpus',
        'c-est-quoi-rabotka.md',
      ),
      'utf8',
    );

    expect(corpus).toContain('aucune commission sur ce que vous gagnez');
    expect(corpus).toContain('déblocage');
  });
});
