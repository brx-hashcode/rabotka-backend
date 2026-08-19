import { ProfileType } from '@prisma/client';
import { destinationFor } from '../destination';

const worker = (text: string) => destinationFor(text, ProfileType.WORKER);
const employer = (text: string) => destinationFor(text, ProfileType.EMPLOYER);

describe('destinationFor', () => {
  it('sends a worker looking for work to the missions list', () => {
    expect(worker('Je cherche un travail')).toBe('jobs');
    expect(worker('je veux une mission')).toBe('jobs');
    expect(worker('tu as un boulot pour moi ?')).toBe('jobs');
  });

  it('sends an employer looking to hire to the publish screen', () => {
    expect(employer('Je cherche un travailleur')).toBe('job-offers/new');
    expect(employer("j'ai besoin de quelqu'un")).toBe('job-offers/new');
    expect(employer('je veux recruter')).toBe('job-offers/new');
  });

  // Ordered most-specific first: a message can mention both.
  it('prefers the specific subject over the general one', () => {
    expect(worker('comment payer mes pénalités de la mission ?')).toBe(
      'penalites/paiement',
    );
    expect(worker('mon solde de crédit pour une mission')).toBe('portefeuille');
    expect(worker('je veux voir mes réalisations')).toBe('profile/portfolio');
  });

  it('routes support and disputes to the claim screen', () => {
    expect(worker('on m’a arnaqué')).toBe('claims/new');
    expect(employer('je veux faire une réclamation')).toBe('claims/new');
  });

  it('ignores accents, as a phone keyboard drops them', () => {
    expect(worker('mes penalites')).toBe('penalites/paiement');
    expect(worker('mes pénalités')).toBe('penalites/paiement');
  });

  it('falls back to the role’s home screen', () => {
    expect(worker('bonjour')).toBe('jobs');
    expect(employer('bonjour')).toBe('dashboard');
  });

  // A worker has no employer screens and vice versa.
  it('never sends a worker to an employer screen', () => {
    expect(worker('je veux recruter quelqu’un')).not.toContain('job-offers');
  });
});

describe('destinationFor — falling back to the reply', () => {
  // « Pourquoi Rabotka ? » names no screen, but the answer offers one, and a
  // « oui » to that offer must open what was offered.
  it('reads the screen out of the reply when the question named none', () => {
    expect(
      destinationFor(
        'Pourquoi Rabotka ?',
        ProfileType.EMPLOYER,
        'Vous voulez que je vous ouvre *Publier une mission* ?',
      ),
    ).toBe('job-offers/new');
  });

  it('lets the question win over the reply', () => {
    expect(
      destinationFor(
        'comment payer mes pénalités ?',
        ProfileType.WORKER,
        'Vous trouverez les missions disponibles dans l’application.',
      ),
    ).toBe('penalites/paiement');
  });

  // The reply may only choose a screen when it NAMES one: « une trace en cas de
  // problème » is not a request for the claims form.
  it('ignores incidental words in the reply', () => {
    expect(
      destinationFor(
        'Pourquoi Rabotka ?',
        ProfileType.EMPLOYER,
        'Ici vous voyez l’historique et une trace en cas de problème.',
      ),
    ).toBe('dashboard');
  });

  it('still defaults when neither names a screen', () => {
    expect(
      destinationFor('merci !', ProfileType.EMPLOYER, 'Avec plaisir.'),
    ).toBe('dashboard');
  });
});
