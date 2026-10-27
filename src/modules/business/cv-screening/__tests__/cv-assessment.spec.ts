import {
  assessmentMessages,
  overallScore,
  parseAssessment,
} from '../cv-assessment';

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    isCv: true,
    candidate: {
      name: 'Grâce Mabiala',
      currentTitle: 'Caissière',
      city: 'Brazzaville',
      yearsExperience: 4,
      email: 'g@m.cg',
      phone: '+242 06 000 00 00',
    },
    criteria: {
      skills: 80,
      experience: 70,
      training: 50,
      location: null,
      languages: 90,
    },
    summary: 'Profil solide.',
    strengths: ['Caisse', 'Service client'],
    gaps: ['Pas de permis'],
    ...over,
  });

describe('parseAssessment', () => {
  it('reads the JSON, fenced or with prose around it', () => {
    const parsed = parseAssessment(
      'Voici :\n```json\n' + answer() + '\n```\nBonne journée',
    );
    expect(parsed?.candidate.name).toBe('Grâce Mabiala');
    expect(parsed?.criteria).toEqual({
      skills: 80,
      experience: 70,
      training: 50,
      languages: 90,
    });
  });

  it('keeps marks within 0–100 and lists to three', () => {
    const parsed = parseAssessment(
      answer({
        criteria: { skills: 140, experience: -5, training: 66.6 },
        strengths: ['a', 'b', 'c', 'd'],
      }),
    );
    expect(parsed?.criteria).toEqual({
      skills: 100,
      experience: 0,
      training: 67,
    });
    expect(parsed?.strengths).toEqual(['a', 'b', 'c']);
  });

  it('counts the years from the career, not from the model', () => {
    const parsed = parseAssessment(
      answer({
        candidate: {
          name: 'Grâce',
          yearsExperience: 9,
          experiences: [
            {
              title: 'Caissière',
              start: '2020-01',
              end: '2021-12',
              type: 'FULL_TIME',
              relevance: 'HIGH',
            },
            {
              title: 'Vendeuse',
              start: '2021-01',
              end: '2022-12',
              type: 'PART_TIME',
              relevance: 'PARTIAL',
            },
          ],
        },
      }),
      new Date('2026-10-15T00:00:00Z'),
    );
    expect(parsed?.candidate).toMatchObject({
      experienceMonths: 36,
      relevantMonths: 27,
      yearsExperience: 3,
    });
    expect(parsed?.candidate.experiences).toHaveLength(2);
  });

  it('keeps the model’s years when the CV gives no dates', () => {
    expect(parseAssessment(answer())?.candidate).toMatchObject({
      yearsExperience: 4,
      experiences: [],
      experienceMonths: null,
    });
  });

  it('is null for anything but the JSON asked for', () => {
    expect(parseAssessment('Je ne peux pas lire ce fichier.')).toBeNull();
    expect(parseAssessment('{"isCv": "oui"}')).toBeNull();
    expect(parseAssessment('{not json}')).toBeNull();
  });

  it('accepts a document that is not a CV with nothing else', () => {
    expect(parseAssessment('{"isCv": false}')).toMatchObject({
      isCv: false,
      strengths: [],
      criteria: {},
    });
  });
});

describe('overallScore', () => {
  it('weighs the criteria the job asks about, and only those', () => {
    // (80*35 + 70*30 + 50*15 + 90*10) / 90
    expect(
      overallScore({ skills: 80, experience: 70, training: 50, languages: 90 }),
    ).toBe(73);
    expect(overallScore({ skills: 40 })).toBe(40);
    expect(overallScore({})).toBe(0);
  });
});

describe('assessmentMessages', () => {
  const job = { title: 'Caissier', text: 'Tenir la caisse.' };

  it('puts the CV text after the job', () => {
    const [, human] = assessmentMessages(job, { kind: 'text', text: 'CV ici' });
    expect(human.content).toContain('Offre : Caissier');
    expect(human.content).toContain('CV :\nCV ici');
  });

  it('attaches a photo as an image and a scan as a PDF', () => {
    const [, image] = assessmentMessages(job, {
      kind: 'image',
      mimeType: 'image/png',
      base64: 'AAA',
    });
    expect(image.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
    const [, pdf] = assessmentMessages(job, { kind: 'pdf', base64: 'BBB' });
    expect((pdf.content as unknown[])[1]).toEqual({
      type: 'media',
      mimeType: 'application/pdf',
      data: 'BBB',
    });
  });
});
