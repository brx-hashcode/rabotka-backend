import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Le contenu de `kyc-refuse.md`, testé comme du code.
 *
 * Longtemps, les pièces n'étaient acceptées qu'à la création du profil, et ce
 * fichier devait dire « on ne renvoie pas ses documents soi-même ». Depuis que
 * `POST /profile/me/kyc` existe (page Profil › Vérification d'identité), c'est
 * l'inverse : une personne refusée renvoie ses pièces elle-même, et la
 * réclamation sert à contester. Le test garde ce fichier fidèle au produit.
 *
 * Il porte sur le FICHIER plutôt que sur une réponse du modèle : c'est la
 * régression qui compte, et elle se réintroduit en éditant ce markdown.
 */

const corpus = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'corpus', `${name}.md`), 'utf8');

describe('corpus/kyc-refuse.md', () => {
  const text = corpus('kyc-refuse');

  it('ne dit plus qu’aucun écran ne permet de renvoyer ses documents', () => {
    expect(text).not.toMatch(/on ne renvoie pas|pas d'écran|il n'existe pas/i);
  });

  it('mène à la page où l’on renvoie ses documents', () => {
    expect(text).toContain("*Vérification d'identité*");
    expect(text).toContain('action_id: action:verification');
  });

  it('garde la réclamation pour contester', () => {
    expect(text).toContain('*Réclamations*');
  });

  it('ne promet aucun délai', () => {
    expect(text).not.toMatch(/sous \d+ ?(h|heures|jours)/i);
    expect(text).toContain('pas de délai garanti');
  });
});

describe('corpus/litige-reclamation.md', () => {
  const text = corpus('litige-reclamation');

  it('dit COMMENT ouvrir une réclamation, pas seulement quoi y mettre', () => {
    expect(text).toContain('*Réclamations*');
    expect(text).toContain('Soumettez');
  });
});
