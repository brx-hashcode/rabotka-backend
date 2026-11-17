import { applicantPrompt } from '../applicant-score/applicant-assessment';
import {
  assessmentMessages,
  assessmentPrompt,
} from '../cv-screening/cv-assessment';
import {
  CHAT_RULES,
  OffTopicError,
  chatLanguage,
  chatPrompt,
} from '../cv-screening/cv-chat.service';
import { reportLanguage, reportPrompt } from '../interview/interview-report';
import { draftMessages, draftPrompt } from '../offer-writer/offer-writer';
import { promptIn, writtenIn } from '../output-language';

const ENGLISH_JOB = {
  title: 'Sales assistant',
  text: 'We are looking for a sales assistant to help our customers. You will work with the store manager and you need two years of experience.',
};
const FRENCH_JOB = {
  title: 'Vendeur',
  text: 'Nous recherchons un vendeur pour la boutique. Vous travaillerez avec le responsable et vous accueillerez les clients.',
};

describe('the language the AI writes in', () => {
  it('follows the first text that shows one, French when none does', () => {
    expect(writtenIn(ENGLISH_JOB.text)).toBe('en');
    expect(writtenIn(FRENCH_JOB.text)).toBe('fr');
    expect(writtenIn('', null, 'RB-2043', ENGLISH_JOB.text)).toBe('en');
    expect(writtenIn('RB-2043')).toBe('fr');
  });

  it('keeps the French prompts exactly as written', () => {
    for (const prompt of [
      assessmentPrompt,
      applicantPrompt,
      reportPrompt,
      draftPrompt,
    ]) {
      expect(prompt('fr')).not.toMatch(/LANGUAGE:/);
    }
    expect(chatPrompt(CHAT_RULES, 'fr')).toBe(CHAT_RULES);
  });

  it('asks for English, without asking for French, when the job is in English', () => {
    for (const prompt of [
      assessmentPrompt('en'),
      applicantPrompt('en'),
      reportPrompt('en'),
      draftPrompt('en'),
      chatPrompt(CHAT_RULES, 'en'),
    ]) {
      expect(prompt).toMatch(/LANGUAGE: .*ENGLISH/);
      expect(prompt).not.toMatch(/en français|Français clair/);
    }
    expect(draftPrompt('en')).toContain('Apply directly online on Rabotka.');
  });

  it('analyses a CV in the language of its job', () => {
    const cv = { kind: 'text' as const, text: 'Jean Dupont, vendeur' };
    const system = (job: typeof ENGLISH_JOB) =>
      assessmentMessages(job, cv)[0].content as string;
    expect(system(ENGLISH_JOB)).toContain('LANGUAGE:');
    expect(system(FRENCH_JOB)).not.toContain('LANGUAGE:');
  });

  it('writes an offer in the language of the request', () => {
    const base = { businessName: 'Acme', brief: '' };
    const system = (brief: string) =>
      draftMessages(
        { ...base, brief } as Parameters<typeof draftMessages>[0],
        [],
      )[0].content as string;
    expect(system(ENGLISH_JOB.text)).toContain('LANGUAGE:');
    expect(system(FRENCH_JOB.text)).not.toContain('LANGUAGE:');
  });

  it('writes a report in the job’s language, else the notes’', () => {
    const c = {
      jobTitle: 'Vendeur',
      offerDescription: null,
      notes: 'She has the experience we need and she is available now.',
    } as unknown as Parameters<typeof reportLanguage>[0];
    expect(reportLanguage(c)).toBe('en');
    expect(reportLanguage({ ...c, offerDescription: FRENCH_JOB.text })).toBe(
      'fr',
    );
  });

  it('answers a chat question in its own language, then the job’s', () => {
    expect(chatLanguage('What are her strengths?', [], FRENCH_JOB)).toBe('en');
    expect(chatLanguage('Quels sont ses atouts ?', [], ENGLISH_JOB)).toBe('fr');
    expect(chatLanguage('ok', ['Is he a good fit?'], FRENCH_JOB)).toBe('en');
    expect(chatLanguage('ok', [], ENGLISH_JOB)).toBe('en');
    expect(chatLanguage('Résumez son parcours.', [], ENGLISH_JOB)).toBe('fr');
    expect(new OffTopicError('en').message).toMatch(/^This question/);
    expect(new OffTopicError().message).toMatch(/^Cette question/);
  });

  it('refuses a replacement that is not in the prompt', () => {
    expect(() =>
      promptIn('abc', 'en', { replace: [['xyz', '']], directive: '' }),
    ).toThrow();
  });
});
