// Dupliqué depuis src/modules/job-offer/utils/job-reference.util.ts.
// Les scripts de seed prod tournent dans un conteneur sans le dossier src/ (dist/ + prisma/
// + node_modules uniquement), donc importer depuis ../../src/ y plante ("Cannot find module").
// Garder ce fichier synchronisé manuellement si la logique source change.
// Seule generateJobReference est reprise (seule fonction utilisée par les seeds) ;
// normalizeJobReference et isValidReferenceShape ne sont pas repris car non utilisés.
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

export function generateJobReference(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `RBT-${code}`;
}
