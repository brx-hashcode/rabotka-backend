import { ProfileType } from '@prisma/client';
import { buildTools } from '../tools';

/**
 * These assertions are about the SHAPE of what the agent can do, not about any
 * one tool's behaviour. They are the cheap check that nobody reintroduced a
 * mutation while adding a feature.
 */
function makeDeps() {
  return {
    profiles: {} as never,
    jobOffers: {} as never,
    applications: {} as never,
    wallet: {} as never,
    unlock: {} as never,
    systemConfig: {} as never,
    help: {} as never,
    categories: {} as never,
  };
}

const ctx = { profileId: 'p-1', profileType: ProfileType.WORKER };

describe('tool surface', () => {
  const names = buildTools(makeDeps(), ctx, ['plomberie']).map((t) => t.name);

  it('exposes no tool that changes anything', () => {
    const forbidden = [
      'escalader_support',
      'payer',
      'postuler',
      'publier_mission',
      'annuler',
      'debloquer',
      'creer_reclamation',
    ];
    for (const name of forbidden) {
      expect(names).not.toContain(name);
    }
  });

  // The card is attached to every reply in code, so there is no navigation tool
  // left for the model to narrate instead of calling.
  it('exposes no navigation tool', () => {
    expect(names).not.toContain('ouvrir_app');
  });

  // An employer asking « combien de candidatures en attente ? » got the wallet
  // balance, because no tool could answer and the model used what it had.
  it('gives an employer the reads their questions need', () => {
    const employerTools = buildTools(
      makeDeps(),
      { ...ctx, profileType: ProfileType.EMPLOYER },
      [],
    ).map((t) => t.name);
    expect(employerTools).toContain('candidatures_recues');
    expect(employerTools).toContain('mes_missions_publiees');
    // Worker-only tools stay out of an employer's set.
    expect(employerTools).not.toContain('mes_candidatures');
    expect(employerTools).not.toContain('rechercher_offres');
  });

  it('keeps the FAQ and the personal reads', () => {
    for (const name of [
      'rechercher_aide',
      'etat_du_profil',
      'solde_credit',
      'mes_candidatures',
      'mes_penalites',
      'etat_deblocage',
      'tarif_deblocage',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('routes support to a tool that only points at the app', () => {
    expect(names).toContain('demander_assistance');
  });

  it('never takes the profile id as a model-supplied argument', () => {
    for (const tool of buildTools(makeDeps(), ctx, [])) {
      const schema = JSON.stringify(tool.schema ?? {});
      expect(schema).not.toContain('profile_id');
      expect(schema).not.toContain('profileId');
      expect(schema).not.toContain('user_id');
    }
  });
});
