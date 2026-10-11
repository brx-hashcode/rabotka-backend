import { AdminJobOfferController } from '../admin-job-offer.controller';
import { JobOfferService } from '../job-offer.service';

const DELETED_AT = new Date('2026-10-11T07:00:00Z');

/**
 * Restoring an offer the employer deleted brings back the applications that
 * went with it — and only those.
 */
describe('JobOfferService — restoring applications deleted with an offer', () => {
  function serviceWith(prisma: unknown) {
    return new (
      JobOfferService as unknown as new (...a: unknown[]) => JobOfferService
    )(prisma, ...Array(11).fill({}));
  }

  it('restores only the applications stamped with the offer deletion', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const service = serviceWith({ application: { updateMany } });

    const restored = await service.restoreApplicationsDeletedWith([
      { id: 'o1', deletedAt: DELETED_AT },
    ]);

    expect(restored).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { job_offer_id: 'o1', deleted_at: DELETED_AT },
      data: { deleted_at: null },
    });
  });

  it('reads when each archived offer was deleted', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'o1', deleted_at: DELETED_AT }]);
    const service = serviceWith({ jobOffer: { findMany } });

    expect(await service.archivedAt(['o1', 'live'])).toEqual([
      { id: 'o1', deletedAt: DELETED_AT },
    ]);
    expect(findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['o1', 'live'] },
      deleted_at: { not: null },
    });
  });
});

describe('AdminJobOfferController.bulkRestore', () => {
  it('reads the deletion instants before restoring, then the applications', async () => {
    const calls: string[] = [];
    const archived = [{ id: 'o1', deletedAt: DELETED_AT }];
    const jobOfferService = {
      archivedAt: jest.fn(() => {
        calls.push('archivedAt');
        return Promise.resolve(archived);
      }),
      restoreApplicationsDeletedWith: jest.fn(() => {
        calls.push('restoreApplications');
        return Promise.resolve(1);
      }),
    };
    const archiveService = {
      restore: jest.fn(() => {
        calls.push('restoreOffers');
        return Promise.resolve({ count: 1 });
      }),
    };
    const controller = new AdminJobOfferController(
      jobOfferService as never,
      { create: jest.fn() } as never,
      archiveService as never,
    );

    const result = await controller.bulkRestore({ ids: ['o1'] }, {
      user: { userId: 'admin-1' },
      headers: {},
    } as never);

    expect(result).toEqual({ count: 1 });
    expect(calls).toEqual([
      'archivedAt',
      'restoreOffers',
      'restoreApplications',
    ]);
    expect(jobOfferService.restoreApplicationsDeletedWith).toHaveBeenCalledWith(
      archived,
    );
  });
});
