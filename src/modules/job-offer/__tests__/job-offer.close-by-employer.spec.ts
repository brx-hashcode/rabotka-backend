import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApplicationStatus, JobOfferStatus } from '@prisma/client';
import { JOB_OFFER_CLOSED } from '../job-offer.events';
import { JobOfferService } from '../job-offer.service';

const EMPLOYER_ID = 'employer-1';
const OFFER_ID = 'offer-1';

describe('JobOfferService.closeByEmployer', () => {
  function setup(opts: {
    status?: JobOfferStatus;
    employerId?: string;
    paying?: number;
    waitingIds?: string[];
  }) {
    const tx = {
      application: {
        count: jest.fn().mockResolvedValue(opts.paying ?? 0),
        findMany: jest
          .fn()
          .mockResolvedValue((opts.waitingIds ?? []).map((id) => ({ id }))),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      jobOffer: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      jobOffer: {
        findFirst: jest.fn().mockResolvedValue({
          id: OFFER_ID,
          employer_id: opts.employerId ?? EMPLOYER_ID,
          status: opts.status ?? JobOfferStatus.ACTIVE,
        }),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const botNotification = {
      sendApplicationRejectedToWorker: jest.fn().mockResolvedValue(undefined),
    };
    const events = { emit: jest.fn() };
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new (
      JobOfferService as unknown as new (...a: unknown[]) => JobOfferService
    )(prisma, {}, {}, {}, botNotification, events, {}, {}, cache, {}, {}, {});
    return { service, tx, events };
  }

  const close = (s: JobOfferService) =>
    s.closeByEmployer(OFFER_ID, EMPLOYER_ID);

  it('expires an offer with nobody hired, so it can be republished', async () => {
    const { service, tx } = setup({});

    await close(service);

    expect(tx.jobOffer.update.mock.calls[0][0].data.status).toBe(
      JobOfferStatus.EXPIRED,
    );
  });

  it('fills an offer with hires: they carry on', async () => {
    const { service, tx } = setup({ status: JobOfferStatus.PARTIALLY_FILLED });

    await close(service);

    expect(tx.jobOffer.update.mock.calls[0][0].data.status).toBe(
      JobOfferStatus.FILLED,
    );
  });

  it('closes those still waiting, and announces it', async () => {
    const { service, tx, events } = setup({ waitingIds: ['a1'] });

    await close(service);

    expect(tx.application.findMany.mock.calls[0][0].where.status).toEqual({
      in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED],
    });
    expect(tx.application.updateMany).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(JOB_OFFER_CLOSED, {
      jobOfferId: OFFER_ID,
      employerId: EMPLOYER_ID,
    });
  });

  it('waits for a payment in progress', async () => {
    const { service, tx } = setup({ paying: 1 });

    await expect(close(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.jobOffer.update).not.toHaveBeenCalled();
  });

  it('refuses an offer already closed', async () => {
    const { service } = setup({ status: JobOfferStatus.EXPIRED });

    await expect(close(service)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is the employer’s alone', async () => {
    const { service } = setup({ employerId: 'someone-else' });

    await expect(close(service)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
