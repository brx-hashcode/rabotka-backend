import {
  formatPenaltyHistory,
  formatPenaltyBlocked,
  formatCancelApplicationNoPenalty,
  formatCancelApplicationWithPenalty,
  type PenaltyItem,
} from '../penalty.messages';

const date = new Date('2026-03-15T10:00:00');

describe('formatPenaltyHistory', () => {
  it('shows empty state when no penalties', () => {
    const msg = formatPenaltyHistory([], 0, 0, 100, 5, 4);
    expect(msg).toContain('Aucune pénalité enregistrée');
  });

  it('renders penalty items with title and reason', () => {
    const items: PenaltyItem[] = [
      {
        id: 'p1',
        amount: 5000,
        reason: 'Annulation tardive',
        appliedAt: date,
        jobOfferTitle: 'Livreur',
      },
    ];
    const msg = formatPenaltyHistory(items, 5000, 1, 80, 3, 4);
    expect(msg).toContain('Livreur');
    expect(msg).toContain('Annulation tardive');
    expect(msg).toContain('5');
  });

  it('renders penalty item without title and reason (null)', () => {
    const items: PenaltyItem[] = [
      {
        id: 'p2',
        amount: 5000,
        reason: null,
        appliedAt: date,
      },
    ];
    const msg = formatPenaltyHistory(items, 5000, 1, 90, 2, 4);
    expect(msg).toContain('5');
    expect(msg).not.toContain('undefined');
  });

  it('includes score and stats in summary', () => {
    const msg = formatPenaltyHistory([], 0, 2, 75, 10, 4);
    expect(msg).toContain('75/100');
    expect(msg).toContain('10');
    expect(msg).toContain('2');
  });
});

describe('formatPenaltyBlocked', () => {
  it('shows total amount', () => {
    const msg = formatPenaltyBlocked(15000, '0700000000', '0800000000');
    expect(msg).toContain('15');
    expect(msg).toContain('FCFA');
    expect(msg).toContain('bloquée');
  });
});

describe('formatCancelApplicationNoPenalty', () => {
  it('renders cancellation details', () => {
    const msg = formatCancelApplicationNoPenalty({
      offerTitle: 'Manutentionnaire',
      scheduledAt: date,
      amount: 8000,
      timeRemaining: '6h',
      thresholdHours: 4,
    });
    expect(msg).toContain('Manutentionnaire');
    expect(msg).toContain('6h');
    expect(msg).toContain('Aucune pénalité');
  });
});

describe('formatCancelApplicationWithPenalty', () => {
  it('renders late cancellation details with score', () => {
    const msg = formatCancelApplicationWithPenalty({
      offerTitle: 'Livreur',
      scheduledAt: date,
      amount: 10000,
      timeRemaining: '2h',
      penaltyAmount: 5000,
      scoreDeduction: 10,
      newScore: 70,
    });
    expect(msg).toContain('Livreur');
    expect(msg).toContain('5');
    expect(msg).toContain('-10 points');
    expect(msg).toContain('70/100');
    expect(msg).toContain('ATTENTION');
  });
});
