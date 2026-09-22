import { ApplicationCancelledBy, ApplicationStatus } from '@prisma/client';
import {
  applicationSummaries,
  isApplied,
} from '../chattable-applications';

let seq = 0;
const row = (
  status: ApplicationStatus,
  cancelledBy: ApplicationCancelledBy | null = null,
  deleted = false,
) => ({
  id: `a-${++seq}`,
  job_offer_id: 'job-1',
  status,
  cancelled_by: cancelledBy,
  deleted_at: deleted ? new Date() : null,
});

const summaryOf = (...rows: ReturnType<typeof row>[]) =>
  applicationSummaries(rows).get('job-1');

describe('applicationSummaries', () => {
  it('says NONE and is absent for an offer never applied to', () => {
    expect(applicationSummaries([]).get('job-1')).toBeUndefined();
    expect(isApplied(undefined)).toBe(false);
  });

  it.each([
    ApplicationStatus.PENDING,
    ApplicationStatus.VIEWED,
    ApplicationStatus.WAITING_PAYMENT,
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.STARTED,
  ])('is LIVE, with a thread to open, on %s', (status) => {
    const s = summaryOf(row(status));
    expect(s?.state).toBe('LIVE');
    expect(s?.applicationId).toMatch(/^a-/);
    expect(isApplied(s)).toBe(true);
  });

  it('says REJECTED rather than "déjà postulé"', () => {
    const s = summaryOf(row(ApplicationStatus.REJECTED));
    expect(s?.state).toBe('REJECTED');
    expect(s?.applicationId).toBeNull();
  });

  it('says ENDED for a finished mission', () => {
    expect(summaryOf(row(ApplicationStatus.END))?.state).toBe('ENDED');
  });

  describe('cancelled applications — the case the old boolean got wrong', () => {
    it('bars a worker who cancelled THEMSELVES', () => {
      const s = summaryOf(
        row(ApplicationStatus.CANCELLED, ApplicationCancelledBy.WORKER),
      );
      expect(s?.state).toBe('SELF_CANCELLED');
      expect(isApplied(s)).toBe(true);
    });

    it.each([
      ['the employer', ApplicationCancelledBy.EMPLOYER],
      ['an unknown hand (NULL, the #709 ghost-cancel victims)', null],
    ])('lets them apply again when cancelled by %s', (_label, by) => {
      // The old feed said "Déjà postulé", disabled, here — while the apply
      // endpoint's own reapplyDecision said ALLOW.
      const s = summaryOf(row(ApplicationStatus.CANCELLED, by));
      expect(s?.state).toBe('CAN_REAPPLY');
      expect(isApplied(s)).toBe(false);
    });

    it('treats a re-application after an employer cancel as live', () => {
      const s = summaryOf(
        row(ApplicationStatus.CANCELLED, ApplicationCancelledBy.EMPLOYER),
        row(ApplicationStatus.PENDING),
      );
      expect(s?.state).toBe('LIVE');
    });
  });

  it('ignores deleted rows, as the apply endpoint does', () => {
    expect(summaryOf(row(ApplicationStatus.PENDING, null, true))?.state).toBe(
      'CAN_REAPPLY',
    );
  });

  it('offers a thread only on the statuses ProfileChatService accepts', () => {
    // If these drift, the button appears and the endpoint refuses it — a dead
    // control, which is worse than no control.
    const offered = Object.values(ApplicationStatus).filter(
      (status) => summaryOf(row(status))?.applicationId,
    );
    expect(offered.sort()).toEqual(
      ['ACCEPTED', 'PENDING', 'STARTED', 'VIEWED', 'WAITING_PAYMENT'].sort(),
    );
  });
});
