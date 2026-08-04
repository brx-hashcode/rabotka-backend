import {
  formatPaymentFlow,
  type OfferListItem,
} from '../offers.messages';

const date = new Date('2026-03-20T09:00:00');

function makeOffer(overrides: Partial<OfferListItem> = {}): OfferListItem {
  return {
    id: 'abc12345-0000-0000-0000-000000000000',
    title: 'Livreur',
    description: 'Livraison de colis en ville',
    scheduled_at: date,
    amount: 10000,
    payment_flow: 'DAILY',
    address: 'Kinshasa, Gombe',
    note: null,
    quantity: 1,
    acceptedCount: 0,
    status: 'ACTIVE',
    employerScore: null,
    ...overrides,
  };
}

describe('formatPaymentFlow', () => {
  it('returns "par heure" for HOURLY', () =>
    expect(formatPaymentFlow('HOURLY')).toBe('par heure'));
  it('returns "par jour" for DAILY', () =>
    expect(formatPaymentFlow('DAILY')).toBe('par jour'));
  it('returns "par mois" for MONTHLY', () =>
    expect(formatPaymentFlow('MONTHLY')).toBe('par mois'));
  it('returns the value unchanged for unknown flow', () =>
    expect(formatPaymentFlow('WEEKLY')).toBe('WEEKLY'));
});
