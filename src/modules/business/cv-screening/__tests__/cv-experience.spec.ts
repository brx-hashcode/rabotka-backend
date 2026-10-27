import {
  durationLabel,
  experienceMonths,
  experiencesSchema,
  experiencesText,
  normaliseExperiences,
  type CvExperience,
} from '../cv-experience';

const NOW = new Date('2026-10-15T00:00:00Z');

const job = (over: Partial<CvExperience>): CvExperience => ({
  title: 'Hôtesse',
  employer: null,
  start: null,
  end: null,
  current: false,
  type: 'FULL_TIME',
  relevance: 'HIGH',
  months: null,
  ...over,
});

describe('cv-experience', () => {
  it('normalises dates and counts each job’s months', () => {
    const raw = experiencesSchema.parse([
      {
        title: 'Hôtesse',
        start: '2020-01',
        end: '2020-12',
        type: 'FULL_TIME',
        relevance: 'HIGH',
      },
      {
        title: 'Caissière',
        start: '2019',
        end: '2019',
        type: 'part_time?',
        relevance: 'x',
      },
      {
        title: 'Accueil',
        start: '03/2025',
        end: null,
        current: true,
        type: 'PART_TIME',
        relevance: 'PARTIAL',
      },
      { title: '', start: '2018-01' },
    ]);
    const list = normaliseExperiences(raw, NOW);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({
      start: '2020-01',
      end: '2020-12',
      months: 12,
    });
    // Unknown labels fall back; a bare year runs January to December.
    expect(list[1]).toMatchObject({
      type: 'UNKNOWN',
      relevance: 'NONE',
      start: '2019-01',
      end: '2019-12',
      months: 12,
    });
    expect(list[2]).toMatchObject({
      start: '2025-03',
      current: true,
      months: 20,
    });
  });

  it('counts simultaneous jobs once, at the better weight', () => {
    const months = experienceMonths(
      [
        job({ start: '2020-01', end: '2021-12' }), // 24 months, full time, related
        job({ start: '2021-01', end: '2022-12', type: 'PART_TIME' }), // overlaps 12
      ],
      NOW,
    );
    // 36 distinct months; related: 24 full + 12 × 0.5 part time.
    expect(months).toEqual({ total: 36, relevant: 30 });
  });

  it('weighs partial relevance, internships and volunteering down', () => {
    expect(
      experienceMonths(
        [
          job({ start: '2022-01', end: '2022-12', relevance: 'PARTIAL' }),
          job({ start: '2023-01', end: '2023-06', type: 'INTERNSHIP' }),
          job({ start: '2024-01', end: '2024-12', type: 'VOLUNTEER' }),
          job({ start: '2025-01', end: '2025-06', relevance: 'NONE' }),
        ],
        NOW,
      ),
    ).toEqual({ total: 24, relevant: 12 }); // 6 + 3 + 3 + 0
  });

  it('leaves out jobs it cannot place, and is null with none', () => {
    expect(
      experienceMonths(
        [
          job({ start: null }),
          job({ start: '2030-01', end: '2031-01' }),
          job({ start: '2020-05', end: 'bientôt' }),
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it('writes the career for the chat', () => {
    const text = experiencesText(
      [
        job({
          title: 'Hôtesse',
          employer: 'Salon',
          start: '2024-01',
          current: true,
          months: 22,
          type: 'PART_TIME',
        }),
      ],
      { total: 22, relevant: 11 },
    );
    expect(text).toContain(
      'Hôtesse chez Salon (2024-01 → aujourd’hui, 1 an et 10 mois, temps partiel, en lien direct avec le poste)',
    );
    expect(text).toContain('équivalent temps plein : 11 mois');
    expect(durationLabel(24)).toBe('2 ans');
  });
});
