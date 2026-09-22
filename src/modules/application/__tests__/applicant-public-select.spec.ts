import * as fs from 'node:fs';
import * as path from 'node:path';
import { APPLICANT_PUBLIC_SELECT } from '../application.service';

/**
 * The employer-facing application endpoints handed out every applicant's
 * phone, email and address — the whole Profile row — before anybody paid to
 * unlock them. These two tests are what keeps that from coming back.
 */
describe('APPLICANT_PUBLIC_SELECT', () => {
  it('carries no contact detail of any kind', () => {
    const keys = Object.keys(APPLICANT_PUBLIC_SELECT);
    for (const forbidden of [
      'phone',
      'direct_phone',
      'email',
      'address',
      'latitude',
      'longitude',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('is an allow-list of exactly what the employer screens render', () => {
    // A new Profile column must stay OUT until somebody decides otherwise.
    expect(Object.keys(APPLICANT_PUBLIC_SELECT).sort()).toEqual(
      ['avatar_url', 'first_name', 'id', 'last_name', 'reliability_score'].sort(),
    );
  });

  /**
   * Every query whose result reaches an EMPLOYER. Reading the source is blunt,
   * but it is the only thing that catches somebody putting `worker: true` back
   * into one of them, and that is exactly how the leak happened — twice: the
   * three listing queries first, then `reject` and `cancelAcceptedByEmployer`,
   * which hand their updated row straight back in the response.
   */
  const EMPLOYER_FACING = [
    'private applicationListInclude',
    'async findByJobOffer(',
    'async findById(',
    'async reject(',
    'async cancelAcceptedByEmployer(',
  ];

  it('is what every employer-facing query uses', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'application.service.ts'),
      'utf8',
    );
    const uses = source.match(/worker: \{ select: APPLICANT_PUBLIC_SELECT \}/g);
    expect(uses?.length).toBe(EMPLOYER_FACING.length);

    for (const fn of EMPLOYER_FACING) {
      const start = source.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      // Bounded by the NEXT method declaration: a fixed window spilled into
      // the method below, which legitimately loads the whole worker to send a
      // WhatsApp message.
      const rest = source.slice(start + fn.length);
      const next = rest.search(/\n {2}(private |public )?(async )?[a-zA-Z_]+\(/);
      const body = rest.slice(0, next === -1 ? undefined : next);
      expect(body).not.toMatch(/worker: true/);
    }
  });
});
