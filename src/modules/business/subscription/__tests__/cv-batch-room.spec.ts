import { cvBatchRoom } from '../business-subscription.service';

describe('cvBatchRoom', () => {
  it('is the plan’s batch while enough « CV inclus » are left', () => {
    expect(cvBatchRoom({ cvBatchMax: 5, cvRemaining: 8 })).toBe(5);
  });

  it('is what is left when that is less than a batch', () => {
    expect(cvBatchRoom({ cvBatchMax: 5, cvRemaining: 2 })).toBe(2);
  });

  it('is the batch on an unlimited plan, and 0 when none is left', () => {
    expect(cvBatchRoom({ cvBatchMax: 5, cvRemaining: null })).toBe(5);
    expect(cvBatchRoom({ cvBatchMax: 5, cvRemaining: 0 })).toBe(0);
  });
});
