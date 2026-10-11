import { offerNotificationLinks } from '../utils/offer-notification-links';

describe('offerNotificationLinks', () => {
  it('lists every path that leads to the offer or its applications', () => {
    expect(offerNotificationLinks(['o1'], ['a1'])).toEqual([
      '/offres/o1',
      '/missions/o1',
      '/job-offers/o1',
      '/candidatures/a1',
      '/applications/a1',
      '/applications/a1/paiement',
    ]);
  });

  it('is empty for nothing', () => {
    expect(offerNotificationLinks([], [])).toEqual([]);
  });
});
