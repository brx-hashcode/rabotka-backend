import { foldText } from '../shared/text';

/**
 * Query expansion for the corpus.
 *
 * This is what replaced the jargon lexicon the original spec called for. That
 * design existed to make an internal Slavic term (`zakaz`) retrievable; the
 * term appears nowhere in this platform — not in the schema, the bot, the
 * client, or any user-facing string — so expanding it would have been
 * scaffolding for a word nobody types.
 *
 * What users *do* type is French without accents, French misspelled, and the
 * everyday word rather than the product's word. That is the real gap between a
 * question and the corpus, and it is what these entries close.
 *
 * Each key is matched against the FOLDED query, so `penalite`, `pénalité` and
 * `PÉNALITÉ` are one entry, not three.
 */
const ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // The product's word vs. the street's word.
  ['boulot', ['mission', 'travail', 'offre']],
  ['job', ['mission', 'travail', 'offre']],
  ['taf', ['mission', 'travail']],
  ['emploi', ['mission', 'offre']],
  ['annonce', ['offre', 'mission']],
  ['patron', ['recruteur', 'employeur']],
  ['employeur', ['recruteur']],
  ['ouvrier', ['travailleur']],
  ['candidat', ['travailleur', 'candidature']],

  // Money, which is most of what support is asked about.
  ['argent', ['paiement', 'credit', 'portefeuille']],
  ['sous', ['argent', 'paiement']],
  ['prix', ['tarif', 'frais']],
  ['cout', ['tarif', 'frais']],
  ['payer', ['paiement', 'tarif']],
  ['rembourse', ['credit', 'conversion', 'expiration']],
  ['momo', ['mobile money', 'paiement']],
  ['airtel', ['mobile money', 'paiement']],
  ['orange money', ['mobile money', 'paiement']],

  // The mechanisms, named the way people name them.
  ['numero', ['contact', 'deblocage']],
  ['telephone', ['contact', 'deblocage']],
  ['debloquer', ['deblocage', 'contact']],
  ['amende', ['penalite']],
  ['sanction', ['penalite']],
  ['bloque', ['penalite', 'blocage', 'compte']],
  ['note', ['evaluation', 'score de fiabilite']],
  ['etoile', ['evaluation', 'note']],
  ['papier', ['kyc', 'verification', 'piece identite']],
  ['carte identite', ['kyc', 'verification']],
  ['cni', ['kyc', 'verification', 'piece identite']],
  ['selfie', ['kyc', 'verification']],
  ['verifie', ['kyc', 'verification']],
  ['inscription', ['inscrire', 'compte', 'profil']],
  ['probleme', ['reclamation', 'litige', 'support']],
  ['plainte', ['reclamation', 'litige']],
  ['arnaque', ['litige', 'reclamation', 'securite']],
  ['aide', ['support', 'assistance']],
  ['parler', ['support', 'humain', 'equipe']],
  ['quelqu un', ['support', 'humain']],
  ['humain', ['support', 'equipe']],
  ['conseiller', ['support', 'equipe']],
  ['reference', ['offre', 'mission', 'retrouver']],
  ['credibilite', ['score de fiabilite', 'confiance', 'evaluation']],
  ['confiance', ['score de fiabilite', 'credibilite']],
  ['serieux', ['score de fiabilite', 'credibilite']],
  ['portfolio', ['realisations', 'photos', 'travaux']],
  ['realisation', ['portfolio', 'photos']],
  ['optimiser', ['profil', 'completer', 'ameliorer']],
  ['ameliorer', ['profil', 'score de fiabilite']],
  ['refuse', ['kyc', 'verification', 'motif', 'rejet']],
  ['rejete', ['kyc', 'verification', 'motif']],
];

/**
 * Appends the aliases whose trigger appears in the query.
 *
 * Additive on purpose — the user's own words are the strongest signal and are
 * never replaced, only supplemented. Deterministic and free: no model call, so
 * it cannot fail, time out, or fall over to a second provider.
 */
export function expandQuery(query: string): string {
  const folded = foldText(query);
  if (!folded) return query;

  const additions = new Set<string>();
  for (const [trigger, expansions] of ALIASES) {
    if (!folded.includes(trigger)) continue;
    for (const term of expansions) {
      if (!folded.includes(foldText(term))) additions.add(term);
    }
  }

  // Accent-folded forms of the accented words, and only those.
  //
  // The dense leg is largely indifferent to accents; the SPARSE leg is not — it
  // matches tokens, and «pénalités» and «penalites» are two different ones. A
  // user typing without accents would otherwise lose the lexical half of the
  // search against a corpus written with them, and vice versa.
  //
  // Only the accented words are folded, rather than appending the whole query
  // again: a duplicated query doubles every term's frequency for no gain and
  // makes the logged query twice as hard to read.
  for (const word of query.split(/\s+/)) {
    const strippedWord = word.replace(/[^\p{L}\p{N}]/gu, '');
    if (!strippedWord) continue;
    const foldedWord = foldText(strippedWord);
    if (foldedWord && foldedWord !== strippedWord.toLowerCase()) {
      additions.add(foldedWord);
    }
  }

  if (additions.size === 0) return query;
  return `${query} ${[...additions].join(' ')}`;
}
