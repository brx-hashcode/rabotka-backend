import { isCurrentPairing } from '../auth.service';

/**
 * Pentest A2-F12 (#868): a phone token stayed valid across pairings, so
 * pairing a replacement phone revived the old (lost, stolen) phone's token.
 */
describe('isCurrentPairing', () => {
  const firstPairing = new Date('2026-10-01T10:00:00.000Z');
  const rePairing = new Date('2026-10-03T09:30:00.000Z');

  it('accepts the token issued for the current pairing', () => {
    expect(isCurrentPairing({ pairedAt: rePairing.getTime() }, rePairing)).toBe(
      true,
    );
  });

  it('refuses the previous phone’s token after a re-pair', () => {
    expect(
      isCurrentPairing({ pairedAt: firstPairing.getTime() }, rePairing),
    ).toBe(false);
  });

  it('accepts a pre-claim token signed for this pairing', () => {
    // Signed a moment before phone_paired_at was written.
    const iat = Math.floor((rePairing.getTime() - 300) / 1000);
    expect(isCurrentPairing({ iat }, rePairing)).toBe(true);
  });

  it('refuses a pre-claim token from an earlier pairing', () => {
    const iat = Math.floor(firstPairing.getTime() / 1000);
    expect(isCurrentPairing({ iat }, rePairing)).toBe(false);
  });

  it('refuses a token with neither claim', () => {
    expect(isCurrentPairing({}, rePairing)).toBe(false);
  });
});
