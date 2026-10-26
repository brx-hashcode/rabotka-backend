import { BusinessTalentService, cleanTags } from '../business-talent.service';
import { PROFILE_NOTIFICATION_EVENT } from '../../profile-notification/profile-notification.events';

const worker = (first: string) => ({
  first_name: first,
  last_name: 'K.',
  avatar_url: null,
  city: 'Brazzaville',
  reliability_score: 90,
  rating_avg: 4.5,
  rating_count: 3,
  status: 'ACTIVE',
  verification_status: 'VERIFIED',
  deleted_at: null,
  category: { name: 'Nettoyage' },
});

describe('BusinessTalentService', () => {
  it('cleans tags: trimmed, no doubles, at most eight', () => {
    expect(cleanTags(['  Ponctuel ', 'ponctuel', '', 'Week-end'])).toEqual([
      'Ponctuel',
      'Week-end',
    ]);
    expect(
      cleanTags(Array.from({ length: 12 }, (_, i) => `t${i}`)),
    ).toHaveLength(8);
  });

  it('lists kept workers first, then those already hired, with their history', async () => {
    const prisma = {
      businessTalent: {
        findMany: jest.fn().mockResolvedValue([
          {
            worker_id: 'w1',
            note: 'Très bien',
            tags: ['Fiable'],
            created_at: new Date('2026-10-20'),
            worker: worker('Awa'),
          },
        ]),
      },
      application: {
        findMany: jest.fn().mockResolvedValue([
          {
            worker_id: 'w2',
            accepted_at: null,
            created_at: new Date('2026-09-01'),
            job_offer: {
              title: 'Serveur',
              scheduled_at: new Date('2026-09-10'),
            },
            worker: worker('Paul'),
          },
          {
            worker_id: 'w1',
            accepted_at: null,
            created_at: new Date('2026-10-01'),
            job_offer: {
              title: 'Ménage',
              scheduled_at: new Date('2026-10-05'),
            },
            worker: worker('Awa'),
          },
          {
            worker_id: 'w2',
            accepted_at: null,
            created_at: new Date('2026-10-02'),
            job_offer: {
              title: 'Plonge',
              scheduled_at: new Date('2026-10-12'),
            },
            worker: worker('Paul'),
          },
        ]),
      },
    };
    const list = await new BusinessTalentService(
      prisma as never,
      {} as never,
    ).list('biz');
    expect(list.map((t) => [t.workerId, t.saved])).toEqual([
      ['w1', true],
      ['w2', false],
    ]);
    expect(list[0]).toMatchObject({
      note: 'Très bien',
      tags: ['Fiable'],
      missionsWithUs: 1,
      available: true,
    });
    expect(list[1]).toMatchObject({
      missionsWithUs: 2,
      lastMissionTitle: 'Plonge',
    });
  });

  describe('invite', () => {
    const setup = (
      o: { status?: string; applied?: number; worker?: boolean } = {},
    ) => {
      const emit = jest.fn();
      const prisma = {
        jobOffer: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'o1',
            title: 'Serveuse',
            status: o.status ?? 'ACTIVE',
          }),
        },
        profile: {
          findFirst: jest
            .fn()
            .mockResolvedValue(o.worker === false ? null : { id: 'w1' }),
        },
        business: {
          findUnique: jest.fn().mockResolvedValue({ name: 'Love Life' }),
        },
        application: { count: jest.fn().mockResolvedValue(o.applied ?? 0) },
      };
      return {
        service: new BusinessTalentService(prisma as never, { emit } as never),
        emit,
      };
    };

    it('notifies the worker once per offer', async () => {
      const { service, emit } = setup();
      await expect(service.invite('biz', 'w1', 'o1')).resolves.toEqual({
        invited: true,
      });
      expect(emit).toHaveBeenCalledWith(
        PROFILE_NOTIFICATION_EVENT,
        expect.objectContaining({
          recipientId: 'w1',
          dedupeKey: expect.stringContaining('o1'),
          input: {
            type: 'JOB_INVITATION',
            jobOfferId: 'o1',
            jobTitle: 'Serveuse',
            businessName: 'Love Life',
          },
        }),
      );
    });

    it('refuses a closed offer, a worker who applied, an inactive worker', async () => {
      await expect(
        setup({ status: 'FILLED' }).service.invite('biz', 'w1', 'o1'),
      ).rejects.toThrow('ne recrute plus');
      await expect(
        setup({ applied: 1 }).service.invite('biz', 'w1', 'o1'),
      ).rejects.toThrow('déjà postulé');
      await expect(
        setup({ worker: false }).service.invite('biz', 'w1', 'o1'),
      ).rejects.toThrow('plus actif');
    });
  });
});
