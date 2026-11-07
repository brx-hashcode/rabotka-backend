import { ForbiddenException } from '@nestjs/common';
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
  description: 'Dix ans de ménage en bureaux.',
  category: { name: 'Ancien métier' },
  categories: [{ category: { name: 'Nettoyage' } }],
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

  it('reads the trade from the worker\'s domains, with the description', async () => {
    const prisma = {
      businessTalent: {
        findMany: jest.fn().mockResolvedValue([
          {
            worker_id: 'w1',
            note: null,
            tags: [],
            created_at: new Date('2026-10-20'),
            worker: worker('Awa'),
          },
        ]),
      },
      application: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new BusinessTalentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const [talent] = await service.list('e1');

    expect(talent.categoryName).toBe('Nettoyage');
    expect(talent.description).toBe('Dix ans de ménage en bureaux.');
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
      o: {
        status?: string;
        applied?: number;
        worker?: boolean;
        noPlan?: boolean;
        email?: string | null;
        claimed?: boolean;
        mailFails?: boolean;
        noSlug?: boolean;
      } = {},
    ) => {
      const emit = jest.fn();
      const sendMail = o.mailFails
        ? jest.fn().mockRejectedValue(new Error('smtp down'))
        : jest.fn().mockResolvedValue({ jobId: 'j1' });
      const claim = jest.fn().mockResolvedValue(o.claimed ?? true);
      const release = jest.fn().mockResolvedValue(undefined);
      const prisma = {
        jobOffer: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'o1',
            title: 'Serveuse',
            status: o.status ?? 'ACTIVE',
            reference: 'RBK-1234',
            employment_type: 'MISSION',
            city: 'Brazzaville',
            country_name: 'Congo',
            is_remote: false,
            scheduled_at: new Date('2026-11-24T08:00:00Z'),
          }),
        },
        profile: {
          findFirst: jest.fn().mockResolvedValue(
            o.worker === false
              ? null
              : {
                  id: 'w1',
                  first_name: 'Awa',
                  email: o.email === undefined ? 'awa@example.com' : o.email,
                },
          ),
        },
        business: {
          findUnique: jest.fn().mockResolvedValue({
            name: 'Love Life',
            public_slug: o.noSlug ? null : 'love-life',
          }),
        },
        application: { count: jest.fn().mockResolvedValue(o.applied ?? 0) },
      };
      const assertCanInvite =
        o.noPlan === true
          ? jest.fn().mockRejectedValue(new ForbiddenException('formule'))
          : jest.fn().mockResolvedValue(undefined);
      return {
        service: new BusinessTalentService(
          prisma as never,
          { emit } as never,
          { assertCanInvite } as never,
          { sendMail } as never,
          { wrap: jest.fn((html: string) => Promise.resolve(html)) } as never,
          { claim, release } as never,
        ),
        emit,
        sendMail,
        claim,
        release,
      };
    };

    it('invites nobody without a plan', async () => {
      const { service, emit } = setup({ noPlan: true });
      await expect(service.invite('biz', 'w1', 'o1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(emit).not.toHaveBeenCalled();
    });

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

    it('e-mails the invitation to the offer, once per worker and offer', async () => {
      const { service, sendMail, claim } = setup();
      await service.invite('biz', 'w1', 'o1');
      expect(claim).toHaveBeenCalledWith(
        expect.stringContaining('invite-mail:o1:w1'),
        expect.any(Number),
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'awa@example.com',
          subject: 'Love Life vous invite à postuler — Serveuse',
          html: expect.stringContaining(
            '/carrieres/love-life/RBK-1234?source=invitation',
          ),
        }),
      );
      const html = (sendMail.mock.calls[0] as [{ html: string }])[0].html;
      expect(html).toContain('RBK-1234');
      expect(html).toContain('Brazzaville, Congo');
      expect(html).toContain('Commence le mardi 24 novembre à 09:00');
    });

    it('still names the reference when the business has no careers page', async () => {
      const { service, sendMail } = setup({ noSlug: true });
      await service.invite('biz', 'w1', 'o1');
      const html = (sendMail.mock.calls[0] as [{ html: string }])[0].html;
      expect(html).not.toContain('/carrieres/');
      expect(html).toContain('RBK-1234');
    });

    it('sends no e-mail without an address, or when already sent', async () => {
      const none = setup({ email: null });
      await none.service.invite('biz', 'w1', 'o1');
      expect(none.sendMail).not.toHaveBeenCalled();

      const again = setup({ claimed: false });
      await again.service.invite('biz', 'w1', 'o1');
      expect(again.sendMail).not.toHaveBeenCalled();
    });

    it('still invites when the e-mail fails, and frees it for a retry', async () => {
      const { service, emit, release } = setup({ mailFails: true });
      await expect(service.invite('biz', 'w1', 'o1')).resolves.toEqual({
        invited: true,
      });
      expect(emit).toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(
        expect.stringContaining('invite-mail:o1:w1'),
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
