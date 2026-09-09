import { ApplicationCancelledBy, ApplicationStatus } from '@prisma/client';
import { reapplyDecision } from '../application.constants';

/**
 * The rule: only a worker's OWN cancellation bars them from applying again.
 *
 * Pure, so it can be exercised without Prisma. The guard around it does the
 * fetching and the throwing; this is the whole of the decision.
 */

const row = (over: Partial<Parameters<typeof reapplyDecision>[0][number]> = {}) => ({
  status: ApplicationStatus.CANCELLED,
  cancelled_by: null,
  deleted_at: null,
  ...over,
});

describe('reapplyDecision', () => {
  it('allows a first application', () => {
    expect(reapplyDecision([])).toBe('ALLOW');
  });

  describe('bars a live application, exactly as before', () => {
    it.each([
      ApplicationStatus.PENDING,
      ApplicationStatus.VIEWED,
      ApplicationStatus.WAITING_PAYMENT,
      ApplicationStatus.ACCEPTED,
      ApplicationStatus.REJECTED,
      ApplicationStatus.STARTED,
      ApplicationStatus.END,
    ])('%s', (status) => {
      expect(reapplyDecision([row({ status })])).toBe('BLOCKED_ACTIVE');
    });
  });

  it('bars the worker who cancelled it themselves', () => {
    expect(
      reapplyDecision([row({ cancelled_by: ApplicationCancelledBy.WORKER })]),
    ).toBe('BLOCKED_SELF_CANCELLED');
  });

  it('allows again after the EMPLOYER cancelled', () => {
    expect(
      reapplyDecision([row({ cancelled_by: ApplicationCancelledBy.EMPLOYER })]),
    ).toBe('ALLOW');
  });

  it('allows again after a SYSTEM timeout', () => {
    // Offer expiry, or an unlock payment window lapsing. The worker did
    // nothing, so they are not treated as having walked away.
    expect(
      reapplyDecision([row({ cancelled_by: ApplicationCancelledBy.SYSTEM })]),
    ).toBe('ALLOW');
  });

  it('allows when the canceller is unknown — this fails OPEN on purpose', () => {
    // NULL is every row cancelled before the column existed. They cannot be
    // classified: the ghost-cancel bug wrote workers' innocent free-text
    // replies through `cancel()` itself, so nothing separates them from a
    // deliberate cancellation.
    //
    // DO NOT "fix" this to bar. Failing closed would permanently block exactly
    // the people PR #709 was merged to unblock.
    expect(reapplyDecision([row({ cancelled_by: null })])).toBe('ALLOW');
  });

  it('ignores soft-deleted rows entirely', () => {
    expect(
      reapplyDecision([
        row({ status: ApplicationStatus.PENDING, deleted_at: new Date() }),
      ]),
    ).toBe('ALLOW');
  });

  describe('with a history of several rows', () => {
    it('bars on any self-cancellation, however old', () => {
      expect(
        reapplyDecision([
          row({ cancelled_by: ApplicationCancelledBy.SYSTEM }),
          row({ cancelled_by: ApplicationCancelledBy.WORKER }),
          row({ cancelled_by: ApplicationCancelledBy.EMPLOYER }),
        ]),
      ).toBe('BLOCKED_SELF_CANCELLED');
    });

    it('prefers the live-application refusal over the self-cancelled one', () => {
      // Both messages are true, but "you already applied" is the one that
      // matches what the worker can see on screen.
      expect(
        reapplyDecision([
          row({ cancelled_by: ApplicationCancelledBy.WORKER }),
          row({ status: ApplicationStatus.PENDING }),
        ]),
      ).toBe('BLOCKED_ACTIVE');
    });

    it('allows when every past row was cancelled by someone else', () => {
      expect(
        reapplyDecision([
          row({ cancelled_by: ApplicationCancelledBy.EMPLOYER }),
          row({ cancelled_by: ApplicationCancelledBy.SYSTEM }),
        ]),
      ).toBe('ALLOW');
    });

    it('does not let a soft-deleted self-cancellation bar anyone', () => {
      expect(
        reapplyDecision([
          row({
            cancelled_by: ApplicationCancelledBy.WORKER,
            deleted_at: new Date(),
          }),
        ]),
      ).toBe('ALLOW');
    });
  });
});
