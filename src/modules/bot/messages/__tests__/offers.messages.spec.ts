import {
  formatOfferList,
  formatOfferListCompact,
  formatOfferDetail,
  formatOfferDetailWithActions,
  formatOfferPublishedSuccess,
  formatNoOffersAvailable,
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

describe('formatOfferList', () => {
  it('renders offer title and amount', () => {
    const msg = formatOfferList([makeOffer()], 1);
    expect(msg).toContain('Livreur');
    expect(msg).toContain('10');
    expect(msg).toContain('FCFA');
  });

  it('truncates long description to 60 chars', () => {
    const longDesc = 'A'.repeat(80);
    const msg = formatOfferList([makeOffer({ description: longDesc })], 1);
    expect(msg).toContain('...');
  });

  it('truncates long address to 40 chars', () => {
    const longAddr = 'B'.repeat(50);
    const msg = formatOfferList([makeOffer({ address: longAddr })], 1);
    expect(msg).toContain('...');
  });

  it('shows next-page action when hasNext=true', () => {
    const msg = formatOfferList([makeOffer()], 1, { hasNext: true });
    expect(msg).toContain('Offre suivante');
  });

  it('does not show next-page when hasNext=false', () => {
    const msg = formatOfferList([makeOffer()], 1, { hasNext: false });
    expect(msg).not.toContain('Offre suivante');
  });

  it('shows total count in header', () => {
    const msg = formatOfferList([makeOffer(), makeOffer()], 5);
    expect(msg).toContain('5 offres');
  });
});

describe('formatOfferListCompact', () => {
  it('renders offer with all spots available (🟢)', () => {
    const msg = formatOfferListCompact(
      [makeOffer({ quantity: 3, acceptedCount: 0 })],
      false,
    );
    expect(msg).toContain('🟢 3 places');
  });

  it('renders offer with no spots (🔴 Complet)', () => {
    const msg = formatOfferListCompact(
      [makeOffer({ quantity: 2, acceptedCount: 2 })],
      false,
    );
    expect(msg).toContain('🔴 Complet');
  });

  it('renders partial spots (🟡)', () => {
    const msg = formatOfferListCompact(
      [makeOffer({ quantity: 4, acceptedCount: 2 })],
      false,
    );
    expect(msg).toContain('🟡 2/4 places');
  });

  it('shows "Voir plus" when hasMore=true', () => {
    const msg = formatOfferListCompact([makeOffer()], true);
    expect(msg).toContain('6 - Voir plus');
  });

  it('does not show "Voir plus" when hasMore=false', () => {
    const msg = formatOfferListCompact([makeOffer()], false);
    expect(msg).not.toContain('6 - Voir plus');
  });

  it('truncates long address', () => {
    const msg = formatOfferListCompact(
      [makeOffer({ address: 'A'.repeat(50) })],
      false,
    );
    expect(msg).toContain('...');
  });

  it('uses quantity=1 when not set', () => {
    const offer = makeOffer();
    delete offer.quantity;
    const msg = formatOfferListCompact([offer], false);
    expect(msg).toContain('🟢 1 place');
  });

  it('renders singular "place restante" when 1 remaining', () => {
    const msg = formatOfferListCompact(
      [makeOffer({ quantity: 3, acceptedCount: 2 })],
      false,
    );
    expect(msg).toContain('🟡 1/3 place');
  });
});

describe('formatOfferDetail', () => {
  it('renders offer details', () => {
    const msg = formatOfferDetail(makeOffer({ note: 'Apportez un vélo' }));
    expect(msg).toContain('Livreur');
    expect(msg).toContain('Personnes requises');
    expect(msg).toContain('Apportez un vélo');
  });

  it('does not show note section when note is null', () => {
    const msg = formatOfferDetail(makeOffer({ note: null }));
    expect(msg).not.toContain("Note de l'employeur");
  });

  it('uses quantity=1 when not set', () => {
    const offer = makeOffer();
    delete offer.quantity;
    const msg = formatOfferDetail(offer);
    expect(msg).toContain('Personnes requises*: 1');
  });
});

describe('formatOfferDetailWithActions', () => {
  it('renders offer with employer score (>=90 = ⭐⭐⭐)', () => {
    const msg = formatOfferDetailWithActions(makeOffer({ employerScore: 95 }));
    expect(msg).toContain('⭐⭐⭐');
  });

  it('renders offer with employer score (>=75 = ⭐⭐)', () => {
    const msg = formatOfferDetailWithActions(makeOffer({ employerScore: 80 }));
    expect(msg).toContain('⭐⭐');
  });

  it('renders offer with employer score (>=60 = ⭐)', () => {
    const msg = formatOfferDetailWithActions(makeOffer({ employerScore: 65 }));
    expect(msg).toContain('⭐');
  });

  it('renders offer with low score (⚠️)', () => {
    const msg = formatOfferDetailWithActions(makeOffer({ employerScore: 50 }));
    expect(msg).toContain('⚠️');
  });

  it('does not render score line when employerScore is null', () => {
    const msg = formatOfferDetailWithActions(makeOffer({ employerScore: null }));
    expect(msg).not.toContain('Fiabilité employeur');
  });

  it('truncates long description to 80 chars', () => {
    const msg = formatOfferDetailWithActions(
      makeOffer({ description: 'D'.repeat(100) }),
    );
    expect(msg).toContain('...');
  });

  it('truncates long address to 50 chars', () => {
    const msg = formatOfferDetailWithActions(
      makeOffer({ address: 'A'.repeat(60) }),
    );
    expect(msg).toContain('...');
  });
});

describe('formatOfferPublishedSuccess', () => {
  it('includes truncated offer ID', () => {
    const msg = formatOfferPublishedSuccess('abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
    expect(msg).toContain('#abc12345');
  });
});

describe('formatNoOffersAvailable', () => {
  it('returns non-empty string', () => {
    expect(formatNoOffersAvailable().length).toBeGreaterThan(0);
  });
});
