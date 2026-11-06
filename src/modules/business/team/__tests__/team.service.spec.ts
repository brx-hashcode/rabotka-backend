import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { BusinessMember } from '@prisma/client';

import { TeamService, type TeamActor } from '../team.service';

const BUSINESS = 'biz-1';
const PROFILE = 'profile-1';

const row = (over: Partial<BusinessMember> = {}): BusinessMember => ({
  id: 'm-1',
  created_at: new Date(),
  updated_at: new Date(),
  business_id: BUSINESS,
  email: 'awa@entreprise.cg',
  name: 'Awa Mbemba',
  role: 'RECRUITER',
  status: 'ACTIVE',
  is_owner: false,
  emails_on: true,
  invited_by_member_id: null,
  invited_at: null,
  joined_at: null,
  last_seen_at: null,
  removed_at: null,
  seat_subscription_id: null,
  ...over,
});

const holder = row({
  id: 'owner',
  name: 'Jean Luc',
  email: 'jean@zuafood.cg',
  role: 'ADMIN',
  is_owner: true,
});

describe('TeamService', () => {
  let prisma: any;
  let subscriptions: any;
  let mail: any;
  let service: TeamService;
  /** The current period's places: the plan's limit and those taken. */
  let limits: Record<string, number | null>;
  let taken: Record<string, number>;
  const admin: TeamActor = {
    businessId: BUSINESS,
    profileId: PROFILE,
    member: holder,
  };

  beforeEach(() => {
    prisma = {
      business: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          name: 'ZuaFood',
          created_at: new Date(),
          profile: {
            email: 'jean@zuafood.cg',
            first_name: 'Jean',
            last_name: 'Luc',
          },
        }),
      },
      businessMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve(row({ ...data, id: 'new' })),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(row({ ...data }))),
      },
      profile: { findFirst: jest.fn().mockResolvedValue(null) },
      businessActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    limits = { RECRUITER: 2, REVIEWER: 0 };
    taken = { RECRUITER: 0, REVIEWER: 0 };
    subscriptions = {
      businessOf: jest.fn().mockResolvedValue(BUSINESS),
      consumeSeat: jest
        .fn()
        .mockImplementation(
          (_b: string, role: string, message: (l: number) => string) => {
            const limit = limits[role];
            if (limit !== null && taken[role] >= limit) {
              return Promise.reject(new ForbiddenException(message(limit)));
            }
            taken[role] += 1;
            return Promise.resolve({ subscriptionId: 'sub-1' });
          },
        ),
    };
    mail = { sendMail: jest.fn().mockResolvedValue({ jobId: 'j' }) };
    const layout = {
      wrap: jest.fn().mockImplementation((h: string) => Promise.resolve(h)),
    };
    service = new TeamService(prisma, subscriptions, mail, layout as any);
  });

  describe('actor', () => {
    it('is the account holder without a member in the token, made on first need', async () => {
      const a = await service.actor(PROFILE);
      expect(a.member.is_owner).toBe(true);
      expect(prisma.businessMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS,
          email: 'jean@zuafood.cg',
          name: 'Jean Luc',
          role: 'ADMIN',
          status: 'ACTIVE',
          is_owner: true,
        }),
      });
    });

    it('refuses a member no longer active', async () => {
      await expect(service.actor(PROFILE, 'gone')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('invite', () => {
    const dto = {
      email: ' Awa@Entreprise.cg ',
      name: 'Awa Mbemba',
      role: 'RECRUITER' as const,
    };

    it('invites a recruiter within the plan, and e-mails the invitation', async () => {
      const m = await service.invite(admin, dto);
      expect(m.status).toBe('INVITED');
      expect(prisma.businessMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS,
          email: 'awa@entreprise.cg',
          role: 'RECRUITER',
          emails_on: true,
          invited_by_member_id: 'owner',
          seat_subscription_id: 'sub-1',
        }),
      });
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'awa@entreprise.cg',
          html: expect.stringContaining(
            '/auth/sign-in?email=awa%40entreprise.cg',
          ),
        }),
      );
    });

    it('counts each role against its own limit', async () => {
      await expect(
        service.invite(admin, { ...dto, role: 'REVIEWER' }),
      ).rejects.toThrow(/n’inclut pas d’évaluateurs/);
      limits.REVIEWER = null;
      taken.RECRUITER = 2;
      await expect(service.invite(admin, dto)).rejects.toThrow(
        /permet 2 recruteurs dans l’équipe, déjà atteint/,
      );
      await expect(
        service.invite(admin, { ...dto, role: 'REVIEWER' }),
      ).resolves.toBeDefined();
    });

    it('takes no place when the invitation cannot be saved: the team counts people', async () => {
      prisma.businessMember.create.mockRejectedValueOnce(new Error('db'));
      await expect(service.invite(admin, dto)).rejects.toThrow('db');
    });

    it('never makes a second administrator', async () => {
      await expect(
        service.invite(admin, { ...dto, role: 'ADMIN' as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('only an administrator invites', async () => {
      await expect(
        service.invite({ ...admin, member: row() }, dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses someone already here, a business account, or a member elsewhere', async () => {
      prisma.businessMember.findUnique.mockResolvedValueOnce(
        row({ status: 'INVITED' }),
      );
      await expect(service.invite(admin, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );

      prisma.profile.findFirst.mockResolvedValueOnce({ id: 'other-business' });
      await expect(service.invite(admin, dto)).rejects.toThrow(
        /compte entreprise/,
      );

      prisma.businessMember.findFirst.mockResolvedValueOnce({
        id: 'elsewhere',
      });
      await expect(service.invite(admin, dto)).rejects.toThrow(
        /autre organisation/,
      );
    });

    it('invites a removed member again on the same row', async () => {
      prisma.businessMember.findUnique.mockResolvedValueOnce(
        row({ id: 'old', status: 'REMOVED' }),
      );
      await service.invite(admin, dto);
      expect(prisma.businessMember.update).toHaveBeenCalledWith({
        where: { id: 'old' },
        data: expect.objectContaining({ status: 'INVITED', removed_at: null }),
      });
      expect(prisma.businessMember.create).not.toHaveBeenCalled();
    });
  });

  describe('admin support', () => {
    it('removes a member of this business, never its holder', async () => {
      prisma.businessMember.findFirst.mockResolvedValueOnce(row({ id: 'm-2' }));
      await service.removeByAdmin(BUSINESS, 'm-2');
      expect(prisma.businessMember.update).toHaveBeenCalledWith({
        where: { id: 'm-2' },
        data: {
          status: 'REMOVED',
          removed_at: expect.any(Date),
          seat_subscription_id: null,
        },
      });
      prisma.businessMember.findFirst.mockResolvedValueOnce(holder);
      await expect(
        service.removeByAdmin(BUSINESS, 'owner'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      prisma.businessMember.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.removeByAdmin(BUSINESS, 'elsewhere'),
      ).rejects.toThrow(/introuvable/);
    });

    it("resends an invitation in the organisation's name", async () => {
      prisma.businessMember.findFirst.mockResolvedValueOnce(
        row({
          id: 'm-3',
          status: 'INVITED',
          invited_at: new Date(Date.now() - 120_000),
        }),
      );
      await service.resendByAdmin(BUSINESS, 'm-3');
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('L’équipe de <strong>ZuaFood</strong>'),
        }),
      );
    });
  });

  describe('roles and removal', () => {
    beforeEach(() =>
      prisma.businessMember.findFirst.mockResolvedValue(row({ id: 'm-2' })),
    );

    it('changes a role only if the new role has room, the member itself aside', async () => {
      await expect(service.setRole(admin, 'm-2', 'REVIEWER')).rejects.toThrow(
        /évaluateurs/,
      );
      limits.REVIEWER = 1;
      await service.setRole(admin, 'm-2', 'REVIEWER');
      expect(prisma.businessMember.update).toHaveBeenCalledWith({
        where: { id: 'm-2' },
        data: { role: 'REVIEWER', seat_subscription_id: 'sub-1' },
      });
      // Counted without the member being moved: its old place frees itself.
      expect(subscriptions.consumeSeat).toHaveBeenLastCalledWith(
        BUSINESS,
        'REVIEWER',
        expect.any(Function),
        'm-2',
      );
    });

    it('never touches the holder', async () => {
      prisma.businessMember.findFirst.mockResolvedValue(holder);
      await expect(service.remove(admin, 'owner')).rejects.toThrow(
        /responsable du compte/,
      );
    });

    it('removes a member: its next call is refused, its place is free again', async () => {
      prisma.businessMember.findFirst.mockResolvedValue(
        row({ id: 'm-2', seat_subscription_id: 'sub-1' }),
      );
      await service.remove(admin, 'm-2');
      expect(prisma.businessMember.update).toHaveBeenCalledWith({
        where: { id: 'm-2' },
        data: {
          status: 'REMOVED',
          removed_at: expect.any(Date),
          seat_subscription_id: null,
        },
      });
    });
  });
});
