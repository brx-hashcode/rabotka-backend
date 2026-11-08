import { applicantCvText } from '../applicant-cv-text';
import type { ApplicantFacts } from '../applicant-assessment';

const facts = (over: Partial<ApplicantFacts> = {}): ApplicantFacts => ({
  trades: ['Comptabilité'],
  description: 'Comptable depuis 6 ans. Appelez-moi au +242 06 123 45 67.',
  city: 'Brazzaville',
  country: 'Congo',
  memberSince: new Date('2025-03-01T00:00:00Z'),
  reliabilityScore: 90,
  ratingAvg: 4.5,
  ratingCount: 2,
  missions: [
    { title: 'Bilan annuel', trade: 'Comptabilité', completedAt: null },
  ],
  portfolio: [],
  answers: [{ question: 'Disponible ?', answer: 'Oui' }],
  ...over,
});

describe('applicantCvText', () => {
  it('reads like a CV, from what Rabotka knows', () => {
    const text = applicantCvText('Awa Ngoma', facts());
    expect(text.startsWith('Awa Ngoma')).toBe(true);
    expect(text).toContain('Métiers : Comptabilité');
    expect(text).toContain('- Bilan annuel (Comptabilité)');
    // The answers go beside the CV (CvUpload.answers), never inside it.
    expect(text).not.toContain('Disponible ?');
  });

  it('never carries a contact, even typed in the presentation', () => {
    const text = applicantCvText('Awa Ngoma', facts());
    expect(text).not.toContain('123 45 67');
  });

  it('adds « Mon CV » when it was sent', () => {
    const text = applicantCvText(
      'Awa Ngoma',
      facts({ cvText: 'Expert-comptable chez Total, 2019-2024. awa@mail.cg' }),
    );
    expect(text).toContain('CV joint par le candidat');
    expect(text).toContain('Expert-comptable chez Total');
    expect(text).not.toContain('awa@mail.cg');
  });

  it('says so when there is no mission yet', () => {
    expect(applicantCvText('Awa', facts({ missions: [] }))).toContain(
      'aucune pour l’instant',
    );
  });
});
