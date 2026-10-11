import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ApplicationStatus,
  AssignmentStatus,
  JobOfferStatus,
  RejectionSource,
} from '@prisma/client';
import { JobOfferService } from '../job-offer.service';

const EMPLOYER_ID = 'employer-1';
const OFFER_ID = 'offer-1';

/**
 * The employer delete rule: blocked only while a worker is engaged on the
 * offer. Waiting candidates are closed with it and told so; rejected or
 * cancelled ones, and cancelled assignments, no longer block.
 */
describe('JobOfferService.deleteByEmployer', () => {
  function setup(opts: {
    offer?: Partial<{ employer_id: string; status: JobOfferStatus }> | null;
    engagedApplications?: number;
    engagedAssignments?: number;
    waitingIds?: string[];
  }) {
    const tx = {
      application: {
        count: jest.fn().mockResolvedValue(opts.engagedApplications ?? 0),
        findMany: jest
          .fn()
          .mockResolvedValue((opts.waitingIds ?? []).map((id) => ({ id }))),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      assignment: {
        count: jest.fn().mockResolvedValue(opts.engagedAssignments ?? 0),
      },
      jobOffer: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      jobOffer: {
        findFirst: jest.fn().mockResolvedValue(
          opts.offer === null
            ? null
            : {
                id: OFFER_ID,
                employer_id: EMPLOYER_ID,
                status: JobOfferStatus.ACTIVE,
                ...opts.offer,
              },
        ),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const botNotification = {
      sendApplicationRejectedToWorker: jest.fn().mockResolvedValue(undefined),
    };
    const matchingService = {
      deleteJobFromIndex: jest.fn().mockResolvedValue(undefined),
    };
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    // Constructor order: prisma, mail, systemConfig, wallet, botNotification,
    // eventEmitter, matching, redis, cache, geo, jobNotification, interactions.
    const service = new (
      JobOfferService as unknown as new (...a: unknown[]) => JobOfferService
    )(
      prisma,
      {},
      {},
      {},
      botNotification,
      {},
      matchingService,
      {},
      cache,
      {},
      {},
      {},
    );
    return { service, prisma, tx, botNotification, matchingService };
  }

  it('refuses when a worker is engaged (hired, paying or done)', async () => {
    const { service, tx } = setup({ engagedApplications: 1 });

    await expect(
      service.deleteByEmployer(OFFER_ID, EMPLOYER_ID),
    ).rejects.toThrow(BadRequestException);
    expect(tx.application.count.mock.calls[0][0].where.status.in).toEqual([
      ApplicationStatus.WAITING_PAYMENT,
      ApplicationStatus.ACCEPTED,
      ApplicationStatus.STARTED,
      ApplicationStatus.END,
    ]);
    expect(tx.jobOffer.update).not.toHaveBeenCalled();
  });

  it('refuses on a confirmed or completed assignment', async () => {
    const { service, tx } = setup({ engagedAssignments: 1 });

    await expect(
      service.deleteByEmployer(OFFER_ID, EMPLOYER_ID),
    ).rejects.toThrow(BadRequestException);
    expect(tx.assignment.count.mock.calls[0][0].where.status.in).toEqual([
      AssignmentStatus.CONFIRMED,
      AssignmentStatus.COMPLETED,
    ]);
  });

  it('closes waiting candidates, deletes, and notifies each of them', async () => {
    const { service, tx, botNotification, matchingService } = setup({
      waitingIds: ['app-1', 'app-2'],
    });

    await service.deleteByEmployer(OFFER_ID, EMPLOYER_ID);

    expect(tx.application.findMany.mock.calls[0][0].where.status.in).toEqual([
      ApplicationStatus.PENDING,
      ApplicationStatus.VIEWED,
    ]);
    expect(tx.application.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['app-1', 'app-2'] } },
      data: expect.objectContaining({
        status: ApplicationStatus.REJECTED,
        rejection_source: RejectionSource.AUTO_FILL,
      }),
    });
    expect(tx.jobOffer.update).toHaveBeenCalledWith({
      where: { id: OFFER_ID },
      data: { deleted_at: expect.any(Date) },
    });
    expect(
      botNotification.sendApplicationRejectedToWorker.mock.calls.map(
        (c) => c[0],
      ),
    ).toEqual(['app-1', 'app-2']);
    expect(matchingService.deleteJobFromIndex).toHaveBeenCalledWith(OFFER_ID);
  });

  it('deletes without notifying anyone when nobody was waiting', async () => {
    const { service, tx, botNotification } = setup({});

    await service.deleteByEmployer(OFFER_ID, EMPLOYER_ID);

    expect(tx.application.updateMany).not.toHaveBeenCalled();
    expect(tx.jobOffer.update).toHaveBeenCalled();
    expect(
      botNotification.sendApplicationRejectedToWorker,
    ).not.toHaveBeenCalled();
  });

  it("refuses someone else's offer", async () => {
    const { service, prisma } = setup({ offer: { employer_id: 'other' } });

    await expect(
      service.deleteByEmployer(OFFER_ID, EMPLOYER_ID),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an offer that is in progress', async () => {
    const { service, prisma } = setup({
      offer: { status: JobOfferStatus.IN_PROGRESS },
    });

    await expect(
      service.deleteByEmployer(OFFER_ID, EMPLOYER_ID),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
