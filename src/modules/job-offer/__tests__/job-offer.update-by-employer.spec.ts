import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ApplicationStatus,
  EmploymentType,
  JobOfferStatus,
} from '@prisma/client';
import { JobOfferService } from '../job-offer.service';
import { UpdateJobOfferDto } from '../dto/update-job-offer.dto';
import { AdminNotificationEvent } from '../../../common/events/admin-notification.events';

const EMPLOYER_ID = 'employer-1';
const OFFER_ID = 'offer-1';
const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

const offerRow = (over: Record<string, unknown> = {}) => ({
  id: OFFER_ID,
  reference: 'RBT-ABCDE',
  employer_id: EMPLOYER_ID,
  title: 'Plombier pour urgence',
  description: 'Réparation fuite eau cuisine et robinet',
  employment_type: EmploymentType.MISSION,
  scheduled_at: inHours(48),
  amount: 15000,
  payment_flow: null,
  address: '12 avenue de la Paix',
  is_remote: false,
  country_code: 'CG',
  country_name: 'Congo',
  city: 'Brazzaville',
  note: null,
  quantity: 2,
  status: JobOfferStatus.ACTIVE,
  category_id: null,
  created_at: new Date(),
  ...over,
});

/**
 * The employer edit of an ACTIVE offer: same rules as creation on the merged
 * result, plus the locks an edit needs once people have applied.
 */
describe('JobOfferService.updateByEmployer', () => {
  function setup(opts: {
    offer?: Record<string, unknown>;
    applications?: { id: string; status: ApplicationStatus }[];
  }) {
    const current = offerRow(opts.offer);
    const prisma: Record<string, unknown> = {
      $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
      offerQuestion: { deleteMany: jest.fn(), createMany: jest.fn() },
      jobOffer: {
        findFirst: jest.fn().mockResolvedValue(current),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...current, ...data }),
        ),
      },
      application: {
        findMany: jest.fn().mockResolvedValue(opts.applications ?? []),
        // The posts taken (takenSeats): hires and those waiting to confirm.
        count: jest
          .fn()
          .mockResolvedValue(
            (opts.applications ?? []).filter((a) =>
              ['ACCEPTED', 'WAITING_PAYMENT', 'STARTED'].includes(a.status),
            ).length,
          ),
      },
      externalApplication: { count: jest.fn().mockResolvedValue(0) },
      jobCategory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cat-1' }),
      },
    };
    const botNotification = {
      sendJobOfferUpdatedToWorker: jest.fn().mockResolvedValue(undefined),
    };
    const matchingService = {
      indexJobOffer: jest.fn().mockResolvedValue(undefined),
    };
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const eventEmitter = { emit: jest.fn() };
    const geo = {
      resolveLocation: jest.fn(
        (dto: { countryCode?: string; city?: string }) => ({
          ...(dto.countryCode ? { country_code: dto.countryCode } : {}),
          ...(dto.city !== undefined ? { city: dto.city } : {}),
        }),
      ),
      canonicalCity: jest.fn((_c: string | null, city: string) => city),
    };
    const jobNotification = { enqueue: jest.fn() };
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
      eventEmitter,
      matchingService,
      {},
      cache,
      geo,
      jobNotification,
      {},
    );
    const edit = (dto: UpdateJobOfferDto, actor = EMPLOYER_ID) =>
      service.updateByEmployer(OFFER_ID, actor, dto);
    return {
      edit,
      prisma,
      botNotification,
      matchingService,
      eventEmitter,
      jobNotification,
    };
  }

  it('updates the offer, re-indexes it and does not re-announce it', async () => {
    const { edit, prisma, matchingService, eventEmitter, jobNotification } =
      setup({});

    await edit({ title: 'Plombier très urgent' });

    expect(prisma.jobOffer.update).toHaveBeenCalledWith({
      where: { id: OFFER_ID },
      data: { title: 'Plombier très urgent' },
    });
    expect(matchingService.indexJobOffer).toHaveBeenCalledWith(OFFER_ID);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      AdminNotificationEvent.JOB_OFFER_UPDATED,
      expect.anything(),
    );
    expect(jobNotification.enqueue).not.toHaveBeenCalled();
  });

  it("refuses someone else's offer", async () => {
    const { edit, prisma } = setup({});

    await expect(edit({ title: 'Autre titre ici' }, 'other')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.jobOffer.update).not.toHaveBeenCalled();
  });

  it.each([
    JobOfferStatus.FILLED,
    JobOfferStatus.EXPIRED,
    JobOfferStatus.IN_PROGRESS,
  ])('refuses a %s offer', async (status) => {
    const { edit } = setup({ offer: { status } });

    await expect(edit({ title: 'Autre titre ici' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('edits a partly filled offer, and follows the posts added', async () => {
    const { edit, prisma } = setup({
      offer: { status: JobOfferStatus.PARTIALLY_FILLED, quantity: 2 },
      applications: [{ id: 'a', status: ApplicationStatus.ACCEPTED }],
    });

    await edit({ quantity: 3 });

    const update = (prisma.jobOffer as { update: jest.Mock }).update;
    expect(update.mock.calls[0][0].data).toMatchObject({
      quantity: 3,
      status: JobOfferStatus.PARTIALLY_FILLED,
    });
  });

  it('fills the offer when the posts come down to those taken', async () => {
    const { edit, prisma } = setup({
      offer: { status: JobOfferStatus.PARTIALLY_FILLED, quantity: 3 },
      applications: [
        { id: 'a', status: ApplicationStatus.ACCEPTED },
        { id: 'b', status: ApplicationStatus.ACCEPTED },
      ],
    });

    await edit({ quantity: 2 });

    const update = (prisma.jobOffer as { update: jest.Mock }).update;
    expect(update.mock.calls[0][0].data.status).toBe(JobOfferStatus.FILLED);
  });

  it('holds the merged offer to the creation rules', async () => {
    const { edit } = setup({});

    await expect(edit({ description: 'trop court' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses a new date that has passed', async () => {
    const { edit } = setup({});

    await expect(
      edit({ scheduled_at: inHours(-1).toISOString() }),
    ).rejects.toThrow(/à venir/);
  });

  it('accepts a new date within the hour: an urgent mission', async () => {
    const { edit, prisma } = setup({});

    await edit({ scheduled_at: inHours(0.5).toISOString() });

    expect(prisma.jobOffer.update).toHaveBeenCalled();
  });

  it('accepts an unchanged date even when it is now close', async () => {
    const close = inHours(1);
    const { edit, prisma } = setup({ offer: { scheduled_at: close } });

    await edit({ scheduled_at: close.toISOString(), title: 'Nouveau titre' });

    expect(prisma.jobOffer.update).toHaveBeenCalled();
  });

  it('locks the employment type once someone has applied', async () => {
    const { edit } = setup({
      applications: [{ id: 'app-1', status: ApplicationStatus.PENDING }],
    });

    await expect(edit({ employment_type: EmploymentType.CDI })).rejects.toThrow(
      /type de contrat/,
    );
  });

  it('lets the type change while nobody has applied', async () => {
    const { edit, prisma } = setup({});

    await edit({ employment_type: EmploymentType.CDD });

    expect(prisma.jobOffer.update.mock.calls[0][0].data).toMatchObject({
      employment_type: EmploymentType.CDD,
    });
  });

  it('refuses a quantity below the slots already taken', async () => {
    const { edit } = setup({
      offer: { quantity: 3 },
      applications: [
        { id: 'a', status: ApplicationStatus.ACCEPTED },
        { id: 'b', status: ApplicationStatus.WAITING_PAYMENT },
      ],
    });

    await expect(edit({ quantity: 1 })).rejects.toThrow(/inférieur/);
  });

  it('notifies candidates still on the offer when the pay changes', async () => {
    const { edit, botNotification } = setup({
      applications: [
        { id: 'pending', status: ApplicationStatus.PENDING },
        { id: 'accepted', status: ApplicationStatus.ACCEPTED },
        { id: 'started', status: ApplicationStatus.STARTED },
      ],
    });

    await edit({ amount: 20000 });

    expect(botNotification.sendJobOfferUpdatedToWorker.mock.calls).toEqual([
      ['pending', ['la rémunération']],
      ['accepted', ['la rémunération']],
    ]);
  });

  it('does not notify anyone for a reworded title', async () => {
    const { edit, botNotification } = setup({
      applications: [{ id: 'pending', status: ApplicationStatus.PENDING }],
    });

    await edit({ title: 'Plombier qualifié' });

    expect(botNotification.sendJobOfferUpdatedToWorker).not.toHaveBeenCalled();
  });

  it('clears the location when the offer goes remote', async () => {
    const { edit, prisma, botNotification } = setup({
      applications: [{ id: 'pending', status: ApplicationStatus.PENDING }],
    });

    await edit({ isRemote: true });

    expect(prisma.jobOffer.update.mock.calls[0][0].data).toMatchObject({
      is_remote: true,
      address: null,
      country_code: null,
      country_name: null,
      city: null,
    });
    expect(botNotification.sendJobOfferUpdatedToWorker).toHaveBeenCalledWith(
      'pending',
      ['le lieu'],
    );
  });

  it('refuses an unknown category', async () => {
    const { edit, prisma } = setup({});
    prisma.jobCategory.findUnique.mockResolvedValue(null);

    await expect(edit({ category_id: 'nope' })).rejects.toThrow(
      /Catégorie introuvable/,
    );
  });
});
