import {
  applicantMessages,
  applicantScore,
  parseApplicantAssessment,
  reliabilityMark,
} from '../applicant-assessment';

describe('applicant-assessment', () => {
  it('reads the AI’s three marks, bounded, and keeps reliability out of its hands', () => {
    const parsed = parseApplicantAssessment(
      'Voici : {"criteria": {"trade": 140, "experience": 66.6, "location": null, "reliability": 5}, "summary": "Bon profil.", "strengths": ["a","b","c","d"], "gaps": []}',
    );
    expect(parsed?.criteria).toEqual({ trade: 100, experience: 67 });
    expect(parsed?.strengths).toEqual(['a', 'b', 'c']);
    expect(parseApplicantAssessment('Désolé.')).toBeNull();
  });

  it('weighs the known criteria only', () => {
    expect(
      applicantScore({
        trade: 80,
        experience: 60,
        location: 100,
        reliability: 90,
      }),
    ).toBe(Math.round((80 * 40 + 60 * 30 + 100 * 15 + 90 * 15) / 100));
    // No location (remote, or city unknown): the rest carries the weight.
    expect(applicantScore({ trade: 80, experience: 60, reliability: 90 })).toBe(
      Math.round((80 * 40 + 60 * 30 + 90 * 15) / 85),
    );
    expect(applicantScore({})).toBe(0);
  });

  it('computes reliability from the score and, once rated, the ratings', () => {
    expect(
      reliabilityMark({
        reliabilityScore: 90,
        ratingAvg: null,
        ratingCount: 0,
      }),
    ).toBe(90);
    expect(
      reliabilityMark({ reliabilityScore: 90, ratingAvg: 4, ratingCount: 3 }),
    ).toBe(86);
    expect(
      reliabilityMark({
        reliabilityScore: null,
        ratingAvg: null,
        ratingCount: 0,
      }),
    ).toBeNull();
  });

  it('gives the model the offer and the profile, never a name', () => {
    const [, human] = applicantMessages(
      {
        title: 'Hôtesse',
        description: 'Accueil sur un salon.',
        trade: 'Traiteur & Événementiel',
        city: 'Komono',
        country: 'Congo-Brazzaville',
        isRemote: false,
        note: null,
      },
      {
        trades: ['Accueil'],
        description: 'Hôtesse depuis 5 ans.',
        city: 'Brazzaville',
        country: null,
        memberSince: new Date('2026-01-01'),
        reliabilityScore: 95,
        ratingAvg: 4.5,
        ratingCount: 2,
        missions: [
          {
            title: 'Hôtesse salon',
            trade: 'Accueil',
            completedAt: new Date('2026-09-01'),
          },
        ],
        portfolio: [],
      },
    );
    const text = human.content as string;
    expect(text).toContain('Offre : Hôtesse');
    expect(text).toContain('Lieu : Komono, Congo-Brazzaville');
    expect(text).toContain('Métiers déclarés : Accueil');
    expect(text).toContain('- Hôtesse salon (Accueil), 2026-09-01');
  });
});
