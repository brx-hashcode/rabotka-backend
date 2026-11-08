import {
  startLine,
  talentInviteEmail,
  talentInviteSubject,
  type TalentInviteMail,
} from '../talent-invite-email';

// 10:00 in Brazzaville (UTC+1).
const NOW = new Date('2026-11-07T09:00:00Z');

const mail = (o: Partial<TalentInviteMail> = {}): TalentInviteMail => ({
  firstName: 'Awa',
  businessName: 'Love Life',
  businessSlug: 'love-life',
  jobTitle: 'Serveuse',
  reference: 'RBK-1234',
  employmentType: 'MISSION',
  city: 'Brazzaville',
  countryName: 'Congo',
  isRemote: false,
  scheduledAt: null,
  ...o,
});

describe('talent invite email', () => {
  it('gives a mission starting the same day its hour, as urgent', () => {
    const m = mail({ scheduledAt: new Date('2026-11-07T13:00:00Z') });
    expect(startLine(m, NOW)).toBe('Commence aujourd’hui à 14:00');
    expect(talentInviteSubject(m, NOW)).toBe(
      'Urgent : Love Life vous invite à postuler — Serveuse',
    );
    expect(talentInviteEmail(m, NOW)).toContain('Mission urgente');
  });

  it('says « demain » for the next day', () => {
    const m = mail({ scheduledAt: new Date('2026-11-08T07:30:00Z') });
    expect(startLine(m, NOW)).toBe('Commence demain à 08:30');
  });

  it('gives a later mission its full date and hour, not urgent', () => {
    const m = mail({ scheduledAt: new Date('2026-11-24T08:00:00Z') });
    expect(startLine(m, NOW)).toBe('Commence le mardi 24 novembre à 09:00');
    expect(talentInviteSubject(m, NOW)).not.toContain('Urgent');
    expect(talentInviteEmail(m, NOW)).not.toContain('Mission urgente');
  });

  it('never says « à partir du » a start already past', () => {
    const past = new Date('2026-11-07T07:00:00Z');
    expect(startLine(mail({ scheduledAt: past }), NOW)).toBe(
      'Commencée le samedi 7 novembre à 08:00',
    );
    expect(
      startLine(mail({ employmentType: 'CDI', scheduledAt: past }), NOW),
    ).toBeNull();
  });

  it('gives a contract its start day only', () => {
    const m = mail({
      employmentType: 'CDD',
      scheduledAt: new Date('2026-12-01T08:00:00Z'),
    });
    expect(startLine(m, NOW)).toBe('À partir du 1 décembre 2026');
  });
});
