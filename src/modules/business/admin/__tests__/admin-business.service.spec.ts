import { ForbiddenException } from '@nestjs/common';

import { AdminBusinessService } from '../admin-business.service';

describe('AdminBusinessService', () => {
  let prisma: any;
  let subscriptions: any;
  let service: AdminBusinessService;

  beforeEach(() => {
    prisma = {
      business: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'b-1', verification_status: 'VERIFIED' }),
      },
      application: { count: jest.fn().mockResolvedValue(0) },
      externalApplication: { count: jest.fn().mockResolvedValue(0) },
      jobOffer: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(2),
      },
      businessMember: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(3),
      },
      businessMailbox: { findMany: jest.fn().mockResolvedValue([]) },
      businessDocument: { count: jest.fn().mockResolvedValue(0) },
      businessActivity: { findFirst: jest.fn().mockResolvedValue(null) },
      interview: { findMany: jest.fn().mockResolvedValue([]) },
      cvScreening: { findMany: jest.fn().mockResolvedValue([]) },
      adminBusinessNote: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    subscriptions = {
      entitlements: jest.fn().mockResolvedValue({
        plan: { name: 'Pro' },
        status: 'ACTIVE',
        endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }),
    };
    service = new AdminBusinessService(
      prisma,
      {} as any,
      subscriptions,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('has nothing to flag on a healthy business', async () => {
    const h = await service.health('p-1');
    expect(h.alerts).toEqual([]);
    expect(h.openOffers).toBe(2);
    expect(h.teamSize).toBe(3);
  });

  it('flags what is stuck', async () => {
    subscriptions.entitlements.mockResolvedValue({
      plan: { name: 'Essai' },
      status: 'TRIAL',
      endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    prisma.business.findUnique.mockResolvedValue({
      id: 'b-1',
      verification_status: 'PENDING',
    });
    prisma.application.count.mockResolvedValueOnce(2); // waiting Rabotka candidates
    prisma.externalApplication.count.mockResolvedValueOnce(1); // waiting direct ones
    prisma.jobOffer.findMany.mockResolvedValue([
      { id: 'o-1', title: 'Serveur', scheduled_at: new Date() },
    ]);
    prisma.businessMember.findMany.mockResolvedValue([
      { id: 'm-1', name: 'Awa', email: 'a@e.cg', invited_at: new Date() },
    ]);
    prisma.businessMailbox.findMany.mockResolvedValue([
      { id: 'x', email: 'rh@e.cg' },
    ]);
    prisma.businessDocument.count.mockResolvedValue(1);

    const kinds = (await service.health('p-1')).alerts.map((a) => [
      a.kind,
      a.count,
    ]);
    expect(kinds).toEqual([
      ['VERIFICATION_PENDING', 1],
      ['TRIAL_ENDING', 1],
      ['CANDIDATES_WAITING', 3],
      ['OFFERS_ENDING_UNFILLED', 1],
      ['INVITES_PENDING', 1],
      ['MAILBOX_EXPIRED', 1],
      ['PAPERS_TO_REVIEW', 1],
    ]);
  });

  it('counts what each CV analysis read', async () => {
    prisma.cvScreening.findMany.mockResolvedValue([
      {
        id: 's-1',
        created_at: new Date(),
        job_title: 'Comptable',
        offer_id: null,
        status: 'DONE',
        external: false,
        expires_at: new Date(),
        purged_at: null,
        resumes: [
          { status: 'SCORED' },
          { status: 'SCORED' },
          { status: 'UNREADABLE' },
        ],
      },
    ]);
    const [s] = await service.cvScreenings('p-1');
    expect(s).toMatchObject({ cvs: 3, scored: 2, unreadable: 1, failed: 0 });
  });

  it("lets only a note's author change it", async () => {
    prisma.adminBusinessNote.findFirst.mockResolvedValue({
      author_id: 'admin-2',
    });
    await expect(
      service.editNote('p-1', 'admin-1', 'n-1', 'x'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.deleteNote('p-1', 'admin-1', 'n-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.addNote('p-1', 'admin-1', '   ')).rejects.toThrow(
      /empty/,
    );
  });
});
