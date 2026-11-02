import { interviewIcs } from '../interview-ics';

const base = {
  uid: 'i1',
  sequence: 3,
  startsAt: new Date('2026-11-03T09:00:00.000Z'),
  durationMinutes: 45,
  summary: 'Entretien — Caissier, ZuaFood',
  description: 'Venez avec votre CV;\nmerci',
  location: 'Avenue de la Paix, Brazzaville',
  organizerName: 'ZuaFood',
  now: new Date('2026-10-27T12:00:00.000Z'),
};

describe('interviewIcs', () => {
  it('writes a request with UTC times, the end from the duration, and escaped text', () => {
    const ics = interviewIcs(base);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:i1@rabotka.work');
    expect(ics).toContain('SEQUENCE:3');
    expect(ics).toContain('DTSTART:20261103T090000Z');
    expect(ics).toContain('DTEND:20261103T094500Z');
    expect(ics).toContain('SUMMARY:Entretien — Caissier\\, ZuaFood');
    expect(ics).toContain('DESCRIPTION:Venez avec votre CV\\;\\nmerci');
    expect(ics).toContain('LOCATION:Avenue de la Paix\\, Brazzaville');
    expect(
      ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75),
    ).toBe(true);
  });

  it('cancels with the same UID', () => {
    const ics = interviewIcs({ ...base, cancelled: true });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('UID:i1@rabotka.work');
  });

  it('folds long lines without cutting a character', () => {
    const ics = interviewIcs({ ...base, description: 'é'.repeat(200) });
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(`DESCRIPTION:${'é'.repeat(200)}`);
  });
});
