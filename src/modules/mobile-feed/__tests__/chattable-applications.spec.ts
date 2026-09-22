import { ApplicationStatus } from '@prisma/client';
import { chattableApplicationIds } from '../chattable-applications';

const row = (
  id: string,
  jobOfferId: string,
  status: ApplicationStatus,
) => ({ id, job_offer_id: jobOfferId, status });

describe('chattableApplicationIds', () => {
  it.each([
    ApplicationStatus.PENDING,
    ApplicationStatus.VIEWED,
    ApplicationStatus.WAITING_PAYMENT,
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.STARTED,
  ])('offers the conversation on a %s application', (status) => {
    const map = chattableApplicationIds([row('a-1', 'job-1', status)]);
    expect(map.get('job-1')).toBe('a-1');
  });

  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.CANCELLED,
    ApplicationStatus.END,
  ])('does NOT offer it on a %s application', (status) => {
    // The distinction this whole helper exists for. `applied` counts these —
    // they still bar a re-application — but a conversation on a dead
    // application is closed, so a button here would open a thread nobody can
    // write in.
    const map = chattableApplicationIds([row('a-1', 'job-1', status)]);
    expect(map.has('job-1')).toBe(false);
  });

  it('keeps the live row when an offer carries both', () => {
    // A worker can cancel and, in some paths, end up with a second row on the
    // same offer. The live one is the one with a usable thread.
    const map = chattableApplicationIds([
      row('old', 'job-1', ApplicationStatus.CANCELLED),
      row('live', 'job-1', ApplicationStatus.PENDING),
    ]);
    expect(map.get('job-1')).toBe('live');
  });

  it('stays in step with what ProfileChatService will accept', () => {
    // If these two lists drift, the button appears and the endpoint refuses
    // it — a dead control, which is worse than no control.
    const offered = chattableApplicationIds(
      Object.values(ApplicationStatus).map((s, i) => row(`a-${i}`, `job-${i}`, s)),
    );
    expect(offered.size).toBe(5);
  });

  it('returns an empty map for no rows', () => {
    expect(chattableApplicationIds([]).size).toBe(0);
  });
});
