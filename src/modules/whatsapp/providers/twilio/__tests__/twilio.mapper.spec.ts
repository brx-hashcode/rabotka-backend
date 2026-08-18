import { toE164, toDigits } from '../../../contracts/address';
import {
  toContentSid,
  toContentVariables,
  toProviderAddress,
} from '../twilio.mapper';
import { WHATSAPP_TEMPLATES } from '../../../../../common/constants/whatsapp-templates';

describe('address normalization', () => {
  // Congolese mobiles are +242 0X XXX XXXX; 06 is MTN, 05 is Airtel. Numbers
  // reach us from the profiles table, an admin typing into the back office and
  // the `From` of an inbound webhook, and those do not agree on formatting.
  describe.each([
    ['MTN, already canonical', '+242069917686'],
    ['MTN, spaced as a human writes it', '+242 06 99 17 686'],
    ['MTN, dashed', '+242-06-99-17-686'],
    ['MTN, no plus', '242069917686'],
    ['MTN, 00 international prefix', '00242069917686'],
    ['MTN, whatsapp-prefixed (inbound webhook)', 'whatsapp:+242069917686'],
    ['MTN, surrounding whitespace', '  +242069917686  '],
  ])('%s', (_label, input) => {
    it('normalizes to +242069917686', () => {
      expect(toE164(input)).toBe('+242069917686');
    });
  });

  it('normalizes an Airtel 05 number', () => {
    expect(toE164('+242 05 512 3456')).toBe('+242055123456');
  });

  it('normalizes a non-CG number without special-casing it', () => {
    expect(toE164('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(toE164('+1 (415) 523-8886')).toBe('+14155238886');
  });

  it('does not invent a country code for a bare local number', () => {
    // Guessing +242 would send to whoever owns that number elsewhere. Leaving
    // it malformed makes the provider reject it, which is the safer failure.
    expect(toE164('069917686')).toBe('+069917686');
  });

  it('is idempotent', () => {
    expect(toE164(toE164('+242 06 99 17 686'))).toBe('+242069917686');
  });

  it('strips the plus for Cloud', () => {
    expect(toDigits('+242 06 99 17 686')).toBe('242069917686');
    expect(toDigits('whatsapp:+242069917686')).toBe('242069917686');
  });
});

describe('toProviderAddress (twilio)', () => {
  it('prefixes the channel onto the canonical form', () => {
    expect(toProviderAddress('+242069917686')).toBe('whatsapp:+242069917686');
  });

  it('normalizes before prefixing', () => {
    expect(toProviderAddress('+242 06 99 17 686')).toBe(
      'whatsapp:+242069917686',
    );
  });

  it('does not double-prefix an address that already carries the channel', () => {
    expect(toProviderAddress('whatsapp:+242069917686')).toBe(
      'whatsapp:+242069917686',
    );
  });
});

describe('template mapping', () => {
  it('resolves a key to the registry SID', () => {
    expect(toContentSid('kyc')).toBe(WHATSAPP_TEMPLATES.kyc.contentSid);
  });

  it('builds the numbered variable map from typed params', () => {
    expect(
      toContentVariables('jobRecommendation', {
        firstName: 'Fariol',
        title: 'Plombier',
        amount: '25000',
        address: 'Brazzaville',
        date: '12/08',
        jobOfferId: 'offer-1',
      }),
    ).toEqual({
      '1': 'Fariol',
      '2': 'Plombier',
      '3': '25000',
      '4': 'Brazzaville',
      '5': '12/08',
      '6': 'offer-1',
    });
  });

  it('applies the registry fallbacks for blank optional values', () => {
    // These defaults moved out of the call sites when they started passing raw
    // params, so this is now the only place they are exercised.
    const vars = toContentVariables('cancellation', {
      workerName: 'Alice',
      offerTitle: 'Plomberie',
      date: '12/08',
      reason: '   ',
      penaltyStatus: 'Aucune pénalité',
      jobOfferId: 'offer-1',
    });
    expect(vars['4']).toBe('Aucune raison donnée');
  });

  it('renders a no-param template', () => {
    expect(toContentVariables('applicationRejected', undefined)).toEqual({
      '1': 'recherche-offres',
    });
  });

  it('stringifies numeric params', () => {
    expect(
      toContentVariables('unlockExpiredConversion', { amount: 500 }),
      // '2' is the CTA destination, not a body value — the outbound processor
      // swaps it for a login code. Its absence is what failed every send with
      // Meta 131008.
    ).toEqual({ '1': '500', '2': 'portefeuille' });
  });
});
