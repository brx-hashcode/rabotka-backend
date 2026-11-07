import { paymentFailureMessage } from '../payment-failure';

describe('paymentFailureMessage', () => {
  it('tells the payer why, for pawaPay and MTN MoMo codes alike', () => {
    expect(paymentFailureMessage('INSUFFICIENT_BALANCE')).toMatch(
      /Solde mobile money insuffisant/,
    );
    expect(paymentFailureMessage('NOT_ENOUGH_FUNDS')).toBe(
      paymentFailureMessage('INSUFFICIENT_BALANCE'),
    );
    expect(paymentFailureMessage('PAYMENT_NOT_APPROVED')).toMatch(
      /pas été validée/,
    );
    expect(paymentFailureMessage('PAYER_NOT_FOUND')).toMatch(
      /pas de compte mobile money/,
    );
  });

  it('has nothing to add for an unexplained failure', () => {
    expect(paymentFailureMessage('UNSPECIFIED_FAILURE')).toBeNull();
    expect(paymentFailureMessage('UNKNOWN_ERROR')).toBeNull();
    expect(paymentFailureMessage(null)).toBeNull();
    expect(paymentFailureMessage(undefined)).toBeNull();
  });
});
