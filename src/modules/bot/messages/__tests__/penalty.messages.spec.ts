import {
  formatCancelApplicationNoPenalty,
  formatCancelApplicationWithPenalty,
  type PenaltyItem,
} from '../penalty.messages';

const date = new Date('2026-03-15T10:00:00');

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
