import { ContactRecordOrigin } from '@prisma/client';
import { ContactRecordService } from '../contact-record.service';

/**
 * The ledger writer: one row per payment an employer made to reach a worker.
 *
 * Two properties carry the design, and both are easy to lose in a refactor:
 * a MISSION unlock must never write twice (the multi-seat cascade and a retried
 * `payUnlock` both re-enter it), and a DIRECT unlock must write every time
 * (paying twice for the same worker is charged twice, so it is two rows).
 */
describe('ContactRecordService', () => {
  let prisma: {
    contactRecord: { upsert: jest.Mock; create: jest.Mock };
  };
  let cache: { invalidate: jest.Mock };
  let service: ContactRecordService;

  beforeEach(() => {
    prisma = {
      contactRecord: {
        upsert: jest.fn().mockResolvedValue({ id: 'cr-1' }),
        create: jest.fn().mockResolvedValue({ id: 'cr-1' }),
      },
    };
    cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    service = new ContactRecordService(prisma as never, cache as never);
  });

  const mission = {
    employerId: 'e1',
    workerId: 'w1',
    origin: ContactRecordOrigin.MISSION,
    amount: 500,
    unlockedAt: new Date('2026-09-12T10:00:00Z'),
    jobOfferId: 'j1',
    applicationId: 'a1',
    contactUnlockAttemptId: 'att-1',
  };

  const direct = {
    employerId: 'e1',
    workerId: 'w1',
    origin: ContactRecordOrigin.DIRECT,
    amount: 1000,
    unlockedAt: new Date('2026-09-12T10:00:00Z'),
    paymentId: 'pay-1',
  };

  describe('MISSION', () => {
    it('upserts on the attempt id, so a retry cannot double-write', async () => {
      await service.record(mission);

      expect(prisma.contactRecord.create).not.toHaveBeenCalled();
      expect(prisma.contactRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contact_unlock_attempt_id: 'att-1' },
        }),
      );
    });

    it('re-running writes nothing new — `update` is empty on purpose', async () => {
      // A second call must not move `unlocked_at` or restate the amount. The
      // row is a record of a payment that already happened; re-running the
      // cascade should prove it exists, not rewrite history.
      await service.record(mission);

      const call = prisma.contactRecord.upsert.mock.calls[0][0];
      expect(call.update).toEqual({});
    });

    it('carries the job, application and attempt ids', async () => {
      await service.record(mission);

      expect(prisma.contactRecord.upsert.mock.calls[0][0].create).toMatchObject(
        {
          employer_id: 'e1',
          worker_id: 'w1',
          origin: ContactRecordOrigin.MISSION,
          amount: 500,
          job_offer_id: 'j1',
          application_id: 'a1',
          contact_unlock_attempt_id: 'att-1',
        },
      );
    });
  });

  describe('DIRECT', () => {
    it('creates a row rather than upserting — there is no natural key', async () => {
      await service.record(direct);

      expect(prisma.contactRecord.upsert).not.toHaveBeenCalled();
      expect(prisma.contactRecord.create).toHaveBeenCalledTimes(1);
    });

    it('writes a SECOND row when the same pair pays again', async () => {
      // The rule the whole table is shaped around: one row per payment, not
      // per pair. An employer who pays twice is charged twice, and the ledger
      // has to show both or it stops reconciling against the wallet.
      await service.record(direct);
      await service.record(direct);

      expect(prisma.contactRecord.create).toHaveBeenCalledTimes(2);
    });

    it('leaves the mission-only columns null', async () => {
      await service.record(direct);

      expect(prisma.contactRecord.create.mock.calls[0][0].data).toMatchObject({
        origin: ContactRecordOrigin.DIRECT,
        job_offer_id: null,
        application_id: null,
        contact_unlock_attempt_id: null,
        payment_id: 'pay-1',
      });
    });
  });

  describe('failure handling', () => {
    it('never throws — a ledger gap must not roll back a paid unlock', async () => {
      // By the time this runs the money has moved and the contact details are
      // on their way. Failing loudly here would turn a bookkeeping problem
      // into a customer-facing one, which is strictly worse.
      prisma.contactRecord.create.mockRejectedValue(new Error('db down'));

      await expect(service.record(direct)).resolves.toBeUndefined();
    });

    it('does not invalidate the admin cache when the write failed', async () => {
      prisma.contactRecord.create.mockRejectedValue(new Error('db down'));

      await service.record(direct);

      expect(cache.invalidate).not.toHaveBeenCalled();
    });

    it('invalidates the admin list cache after a successful write', async () => {
      await service.record(direct);

      expect(cache.invalidate).toHaveBeenCalledWith('contact-records');
    });
  });
});
