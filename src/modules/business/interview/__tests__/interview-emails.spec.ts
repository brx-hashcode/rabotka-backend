import {
  interviewAnsweredEmail,
  interviewCancelledEmail,
  interviewChosenEmail,
  interviewGuestEmail,
  interviewInviteEmail,
  interviewLanguage,
  interviewReminderEmail,
  interviewSubject,
  modeLine,
  type InterviewMail,
} from '../interview-emails';

const base: InterviewMail = {
  businessName: 'ZuaFood',
  jobTitle: 'Cashier',
  candidateName: 'Grace',
  // Sunday 15 November 2026, 15:20 in Brazzaville.
  startsAt: new Date('2026-11-15T14:20:00Z'),
  durationMinutes: 45,
  mode: 'VIDEO',
  location: 'https://meet.example.com/abc',
  message: null,
};
const en: InterviewMail = { ...base, language: 'en' };
const FRENCH = /Bonjour|vous|votre/i;

describe('interview e-mails', () => {
  it('stay French by default', () => {
    const html = interviewInviteEmail(base, 'https://x.test/e/1');
    expect(html).toContain('Bonjour Grace,');
    expect(html).toContain('vous propose un entretien');
    expect(html).toContain('dimanche 15 novembre à 15:20');
    expect(html).toContain('En visio : <a href');
    expect(html).toBe(
      interviewInviteEmail({ ...base, language: 'fr' }, 'https://x.test/e/1'),
    );
    expect(interviewSubject.cancelled('Caissier')).toBe(
      'Entretien annulé — Caissier',
    );
    expect(modeLine({ mode: 'PHONE', location: null })).toBe(
      'Par téléphone : le recruteur vous appelle',
    );
  });

  it('invites in English, dates in en-GB', () => {
    const html = interviewInviteEmail(en, 'https://x.test/e/1');
    expect(html).toContain('Hello Grace,');
    expect(html).toContain('is offering you an interview');
    expect(html).toContain('Sunday 15 November at 15:20');
    expect(html).toContain('Video call: <a href');
    expect(html).toContain('reply to the invitation');
    expect(html).not.toMatch(FRENCH);
    const many = interviewInviteEmail(
      { ...en, mode: 'IN_PERSON', location: 'Peace Avenue' },
      'https://x.test/e/1',
      true,
      [base.startsAt],
    );
    expect(many).toContain('is offering you new time slots');
    expect(many).toContain('In person, Peace Avenue');
    expect(many).not.toMatch(FRENCH);
  });

  it('says the other e-mails in English too', () => {
    const cases: [string, string][] = [
      [interviewCancelledEmail(en), 'has cancelled the interview'],
      [interviewChosenEmail(en), 'is confirmed'],
      [interviewReminderEmail(en, 'candidate'), 'is tomorrow'],
      [
        interviewGuestEmail(en, 'Paul', 'https://x.test/g', 'ZuaFood'),
        'invites you to join the video call interview',
      ],
    ];
    for (const [html, sentence] of cases) {
      expect(html).toContain('Hello');
      expect(html).toContain(sentence);
      expect(html).not.toMatch(FRENCH);
    }
    const answered = interviewAnsweredEmail(en, 'DECLINED', 'Sorry');
    expect(answered).toContain('has declined the interview');
    expect(answered).toContain('Sorry');
  });

  it('translates the subjects and the calendar entry', () => {
    expect(interviewSubject.invite('Cashier', false, 'en')).toBe(
      'Interview invitation — Cashier',
    );
    expect(interviewSubject.reminder('Cashier', 'en')).toBe(
      'Reminder: interview tomorrow — Cashier',
    );
    expect(interviewSubject.icsSummary('Cashier', 'ZuaFood', 'en')).toBe(
      'Interview — Cashier (ZuaFood)',
    );
  });

  it('takes the language of the job, French when nothing tells', () => {
    expect(interviewLanguage({ job_title: 'Caissier' })).toBe('fr');
    expect(
      interviewLanguage({
        job_title: 'Cashier',
        offer: {
          description:
            'We are looking for a cashier to join our team. You will welcome customers.',
        },
      }),
    ).toBe('en');
  });
});
