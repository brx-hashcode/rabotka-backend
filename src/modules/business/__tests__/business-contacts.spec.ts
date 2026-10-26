import { BusinessContactsService } from '../business-contacts.service';

const worker = (first: string) => ({
  first_name: first,
  last_name: 'K.',
  avatar_url: null,
  phone: '+242060000000',
  email: null,
  city: 'Brazzaville',
  category: { name: 'Nettoyage' },
});

describe('BusinessContactsService', () => {
  it('lists each worker once, latest unlock first, with every live offer', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        worker_id: 'w1',
        origin: 'MISSION',
        unlocked_at: new Date('2026-10-20'),
        job_offer: { id: 'o2', title: 'Serveur', deleted_at: null },
        worker: worker('Awa'),
      },
      {
        worker_id: 'w2',
        origin: 'DIRECT',
        unlocked_at: new Date('2026-10-10'),
        job_offer: null,
        worker: worker('Paul'),
      },
      {
        worker_id: 'w1',
        origin: 'MISSION',
        unlocked_at: new Date('2026-10-01'),
        job_offer: { id: 'o1', title: 'Agent', deleted_at: null },
        worker: worker('Awa'),
      },
      {
        worker_id: 'w1',
        origin: 'MISSION',
        unlocked_at: new Date('2026-09-01'),
        job_offer: { id: 'o0', title: 'Supprimée', deleted_at: new Date() },
        worker: worker('Awa'),
      },
    ]);
    const service = new BusinessContactsService(
      { contactRecord: { findMany } } as never,
      {} as never,
    );

    const list = await service.list('biz');

    expect(findMany.mock.calls[0][0].where).toEqual({ employer_id: 'biz' });
    expect(list.map((c) => c.workerId)).toEqual(['w1', 'w2']);
    expect(list[0].unlockedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(list[0].offers.map((o) => o.id)).toEqual(['o2', 'o1']);
    expect(list[1].offers).toEqual([]);
  });

  describe('unlock', () => {
    const record = {
      worker_id: 'w1',
      origin: 'DIRECT',
      unlocked_at: new Date('2026-10-26'),
      job_offer: null,
      worker: worker('Awa'),
    };
    const setup = (opts: {
      existing?: boolean;
      covered?: boolean;
      worker?: boolean;
    }) => {
      const findMany = jest
        .fn()
        .mockResolvedValueOnce(opts.existing ? [record] : [])
        .mockResolvedValue([record]);
      const create = jest.fn();
      const prisma = {
        contactRecord: { findMany, create },
        profile: {
          findFirst: jest
            .fn()
            .mockResolvedValue(opts.worker === false ? null : { id: 'w1' }),
        },
        $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ contactRecord: { create } }),
      };
      const subs = {
        assertFeature: jest.fn(),
        consumeDirectUnlock: jest.fn().mockResolvedValue(opts.covered ?? true),
      };
      return {
        service: new BusinessContactsService(prisma as never, subs as never),
        create,
        subs,
      };
    };

    it('reveals a worker on one unit of the quota', async () => {
      const { service, create, subs } = setup({});
      const res = await service.unlock('biz', 'w1');
      expect(create.mock.calls[0][0].data).toMatchObject({
        employer_id: 'biz',
        worker_id: 'w1',
        origin: 'DIRECT',
        amount: 0,
      });
      expect(subs.consumeDirectUnlock).toHaveBeenCalledWith(
        'biz',
        create.mock.calls[0][0].data.id,
        expect.anything(),
      );
      expect(res).toMatchObject({
        spent: true,
        contact: { workerId: 'w1', phone: '+242060000000' },
      });
    });

    it('gives an already unlocked worker back without spending', async () => {
      const { service, create, subs } = setup({ existing: true });
      expect(await service.unlock('biz', 'w1')).toMatchObject({ spent: false });
      expect(create).not.toHaveBeenCalled();
      expect(subs.assertFeature).not.toHaveBeenCalled();
    });

    it('refuses past the quota, and an inactive worker', async () => {
      await expect(
        setup({ covered: false }).service.unlock('biz', 'w1'),
      ).rejects.toThrow('quota');
      await expect(
        setup({ worker: false }).service.unlock('biz', 'w1'),
      ).rejects.toThrow('plus actif');
    });
  });
});
