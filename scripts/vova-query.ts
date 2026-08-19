/**
 * Queries the help corpus directly, with no agent in the way.
 *
 * This is the recall gate. Before a single tool or prompt is written, the
 * question worth answering is whether a French question actually retrieves the
 * right article — a corpus that does not retrieve cannot be rescued by a better
 * model downstream, and an agent in the loop only makes the failure harder to
 * see.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/vova-query.ts "comment payer mes pénalités ?"
 *   node_modules/.bin/tsx scripts/vova-query.ts --suite
 *
 * `--suite` runs a fixed set of real questions and prints the top hit for each,
 * so a change to the corpus or the embedder can be compared at a glance.
 */
import { config } from 'dotenv';
import { createVovaContext } from './vova-context';

config({ path: '.env.local' });
config({ path: '.env' });

/** Questions in the words users actually use, not the corpus's own wording. */
const SUITE: ReadonlyArray<
  readonly [question: string, expectedSource: string]
> = [
  ['c est quoi rabotka', 'c-est-quoi-rabotka'],
  ['comment je m inscris', 'inscription'],
  ['pourquoi je dois envoyer ma carte', 'verification-kyc'],
  ['mon dossier a ete refuse', 'kyc-refuse'],
  ['comment remplir mon profil', 'profil-travailleur'],
  ['je veux publier une mission', 'publier-mission'],
  ['pourquoi je vois pas les numeros', 'numeros-masques'],
  ['comment avoir le contact', 'deblocage-contact'],
  ['il a pas paye je perds mon argent ?', 'deblocage-non-paye'],
  ['c est quoi le credit offert', 'credit-bienvenue'],
  ['comment recharger mon portefeuille', 'portefeuille'],
  ['pourquoi j ai une amende', 'penalites'],
  ['comment payer mes pénalités', 'penalites'],
  ['mon compte est bloque', 'compte-suspendu'],
  ['comment on me note', 'evaluations'],
  ['comment augmenter mon score', 'score-fiabilite'],
  ['pourquoi je recois ces offres', 'recommandations'],
  ['j ai la reference d une offre', 'reference-offre'],
  ['ou en sont mes candidatures', 'mes-candidatures'],
  ['je veux garder des enfants', 'securite-garde-enfants'],
  ['premiere mission conseils', 'securite-premiere-mission'],
  ['on m a arnaque', 'litige-reclamation'],
  ['mon paiement momo est passe mais rien', 'paiement-mobile-money'],
  ['je veux parler a quelqu un', 'contacter-support'],
];

/**
 * Deliberately NOT in the suite: « je cherche un boulot de plombier ».
 *
 * It is a search intent, not a help question — it belongs to
 * `rechercher_offres`, and the corpus is right to have no article for it.
 * Scoring it as a retrieval miss would push us to write an article that exists
 * only to satisfy the benchmark, which is how a corpus starts answering
 * questions nobody asked.
 */

async function main() {
  const ctx = createVovaContext();
  const retrieve = ctx.retrieve;

  try {
    const args = process.argv.slice(2);

    if (args[0] === '--suite') {
      let hitTop1 = 0;
      let hitTop3 = 0;

      for (const [question, expected] of SUITE) {
        const { hits } = await retrieve.search(question, 3);
        const top = hits[0]?.source ?? '—';
        const inTop3 = hits.some((h) => h.source === expected);
        if (top === expected) hitTop1++;
        if (inTop3) hitTop3++;

        const mark = top === expected ? 'OK  ' : inTop3 ? '~top3' : 'MISS';
        console.log(
          `${mark.padEnd(6)} ${question.padEnd(42)} → ${top}` +
            (top === expected ? '' : `   (attendu: ${expected})`),
        );
      }

      const n = SUITE.length;
      console.log('');
      console.log(
        `top-1 : ${hitTop1}/${n} (${Math.round((hitTop1 / n) * 100)}%)`,
      );
      console.log(
        `top-3 : ${hitTop3}/${n} (${Math.round((hitTop3 / n) * 100)}%)`,
      );
      return;
    }

    const question = args.join(' ').trim();
    if (!question) {
      console.error('Usage: vova-query.ts "votre question"  |  --suite');
      process.exit(1);
    }

    const result = await retrieve.search(question, 5);
    console.log(`Question : ${question}`);
    console.log(`Élargie  : ${result.expandedQuery}`);
    if (result.requiredTools.length) {
      console.log(`Outils   : ${result.requiredTools.join(', ')}`);
    }
    console.log('');

    if (result.hits.length === 0) {
      console.log('Aucun résultat.');
      return;
    }

    for (const hit of result.hits) {
      console.log(`#${hit.rank + 1}  ${hit.source} › ${hit.section}`);
      console.log(
        `    score=${hit.score.toFixed(4)} action=${hit.actionId ?? '—'}`,
      );
      console.log(`    ${hit.text.replace(/\s+/g, ' ').slice(0, 160)}…`);
      console.log('');
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
