import { ForbiddenException } from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { ContactedProfilesService } from '../contacted-profiles.service';

const workerRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  first_name: 'Chanel',
  last_name: 'Mabiala',
  avatar_url: null,
  description: 'Nettoyage industriel',
  address: 'Brazzaville',
  phone: '+242069917686',
  email: 'chanel@example.com',
  reliability_score: 92,
  rating_avg: 4.5,
  rating_count: 3,
  portfolio_slug: 'chanel',
  categories: [{ category: { name: 'Nettoyage' } }],
  ...overrides,
});

describe('ContactedProfilesService', () => {
  let service: ContactedProfilesService;
  let prisma: {
    profile: { findUnique: jest.Mock; findMany: jest.Mock };
    walletTransaction: { findMany: jest.Mock };
    paymentRequest: { findMany: jest.Mock };
    contactUnlockAttempt: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ profile_type: ProfileType.EMPLOYER }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      walletTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      paymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
      contactUnlockAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ContactedProfilesService(prisma as never);
  });

  describe('listRecommendationContactIds()', () => {
    it('unions wallet debits and approved mobile-money requests', async () => {
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'w1', created_at: new Date('2026-01-02') },
      ]);
      prisma.paymentRequest.findMany.mockResolvedValue([
        { recommendation_worker_id: 'w2', updated_at: new Date('2026-01-03') },
      ]);

      const ids = await service.listRecommendationContactIds('e1');

      expect([...ids.keys()].sort()).toEqual(['w1', 'w2']);
    });

    it('keeps the earliest payment when a worker was paid for twice', async () => {
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'w1', created_at: new Date('2026-03-01') },
        { reference_id: 'w1', created_at: new Date('2026-01-01') },
      ]);

      const ids = await service.listRecommendationContactIds('e1');

      expect(ids.get('w1')).toEqual(new Date('2026-01-01'));
    });

    it('scopes wallet debits to this employer', async () => {
      await service.listRecommendationContactIds('e1');

      expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            reference_type: 'recommendation_contact',
            wallet: { profile_id: 'e1' },
          }),
        }),
      );
    });
  });

  describe('listContacts()', () => {
    it('refuses a worker — this is an employer-only view of paid contacts', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        profile_type: ProfileType.WORKER,
      });

      await expect(service.listContacts('w1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it('returns nothing when the employer has paid for nobody', async () => {
      expect(await service.listContacts('e1')).toEqual([]);
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it('returns the phone and email for a recommendation unlock', async () => {
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'w1', created_at: new Date('2026-01-02T10:00:00Z') },
      ]);
      prisma.profile.findMany.mockResolvedValue([workerRow('w1')]);

      const [contact] = await service.listContacts('e1');

      expect(contact).toMatchObject({
        id: 'w1',
        phone: '+242069917686',
        email: 'chanel@example.com',
        origin: 'RECOMMENDATION',
        jobTitle: null,
        categories: ['Nettoyage'],
      });
      expect(contact.unlockedAt).toBe('2026-01-02T10:00:00.000Z');
    });

    it('only ever loads workers this employer paid for', async () => {
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'w1', created_at: new Date() },
      ]);
      prisma.profile.findMany.mockResolvedValue([workerRow('w1')]);

      await service.listContacts('e1');

      expect(prisma.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['w1'] } } }),
      );
    });

    it('labels a mission unlock with the job that produced it', async () => {
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([
        {
          worker_id: 'w1',
          unlocked_at: new Date('2026-02-01T08:00:00Z'),
          job_offer: { title: 'Nettoyage bureaux' },
        },
      ]);
      prisma.profile.findMany.mockResolvedValue([workerRow('w1')]);

      const [contact] = await service.listContacts('e1');

      expect(contact.origin).toBe('MISSION');
      expect(contact.jobTitle).toBe('Nettoyage bureaux');
    });

    it('prefers the mission origin when a worker was reached both ways', async () => {
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'w1', created_at: new Date('2026-01-01') },
      ]);
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([
        {
          worker_id: 'w1',
          unlocked_at: new Date('2026-02-01'),
          job_offer: { title: 'Nettoyage bureaux' },
        },
      ]);
      prisma.profile.findMany.mockResolvedValue([workerRow('w1')]);

      const contacts = await service.listContacts('e1');

      expect(contacts).toHaveLength(1);
      expect(contacts[0].origin).toBe('MISSION');
    });

    it('sorts most recently unlocked first', async () => {
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'old', created_at: new Date('2026-01-01') },
        { reference_id: 'recent', created_at: new Date('2026-05-01') },
      ]);
      prisma.profile.findMany.mockResolvedValue([
        workerRow('old'),
        workerRow('recent'),
      ]);

      const contacts = await service.listContacts('e1');

      expect(contacts.map((c) => c.id)).toEqual(['recent', 'old']);
    });
  });
});
