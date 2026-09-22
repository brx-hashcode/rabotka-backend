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

  it('is what the three employer-facing queries use', () => {
    // Reading the source is blunt, but it is the only thing that catches
    // somebody putting `worker: true` back into one of them, and that is
    // exactly how the leak happened.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'application.service.ts'),
      'utf8',
    );
    const uses = source.match(/worker: \{ select: APPLICANT_PUBLIC_SELECT \}/g);
    expect(uses?.length).toBe(3);

    for (const fn of ['applicationListInclude', 'findByJobOffer', 'findById']) {
      const start = source.indexOf(fn === 'applicationListInclude'
        ? 'private applicationListInclude'
        : `async ${fn}(`);
      const body = source.slice(start, start + 1500);
      expect(body).not.toMatch(/\n\s*worker: true,/);
    }
  });
});
