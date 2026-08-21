import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Le contenu de `kyc-refuse.md`, testé comme du code.
 *
 * Ce fichier a passé des mois à conseiller « Recommencez […] Reprenez-la de
 * jour, à plat » à des gens dont le compte venait d'être refusé. Or les pièces
 * ne sont acceptées qu'à la création du profil : `UpdateProfileDto` ne porte
 * aucun champ KYC et aucun écran ne permet de les renvoyer. VoVa envoyait donc
 * ces personnes buter sur une porte qui n'existe pas.
 *
 * Le test porte sur le FICHIER plutôt que sur une réponse du modèle : c'est la
 * régression qui compte, et elle se réintroduit en éditant ce markdown, pas en
 * touchant au code.
 */

const corpus = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'corpus', `${name}.md`), 'utf8');

describe('corpus/kyc-refuse.md', () => {
  const text = corpus('kyc-refuse');

  it('ne conseille plus de renvoyer ses documents', () => {
    // Les formulations exactes qui étaient là, plus les variantes évidentes.
    for (const forbidden of [
      'Recommencez',
      'Reprenez-la',
      'renvoyer',
      'renvoyez',
      'à nouveau votre document',
    ]) {
      // « on ne renvoie pas ses documents soi-même » est légitime : on ne
      // cherche que les tournures qui DEMANDENT de le faire.
      const lines = text
        .split('\n')
        .filter((l) => l.toLowerCase().includes(forbidden.toLowerCase()));
      for (const line of lines) {
        expect(line.toLowerCase()).toMatch(
          /pas d'écran|on ne renvoie pas|il n'y a pas|inutile/,
        );
      }
    }
  });

  it('donne les six étapes de la réclamation, dans l’ordre', () => {
    const steps = [
      '*Réclamations*',
      'titre',
      'description',
      'justificatifs',
      'Soumettez',
      'Revenez',
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = text.indexOf(step, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('propose « Vérification d’identité » comme titre', () => {
    expect(text).toContain("Vérification d'identité");
  });

  it('garde son action_id pour ouvrir la bonne page', () => {
    expect(text).toContain('action_id: action:reclamation');
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
