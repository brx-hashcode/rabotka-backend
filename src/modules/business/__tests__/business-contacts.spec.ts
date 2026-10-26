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
    const service = new BusinessContactsService({
      contactRecord: { findMany },
    } as never);

    const list = await service.list('biz');

    expect(findMany.mock.calls[0][0].where).toEqual({ employer_id: 'biz' });
    expect(list.map((c) => c.workerId)).toEqual(['w1', 'w2']);
    expect(list[0].unlockedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(list[0].offers.map((o) => o.id)).toEqual(['o2', 'o1']);
    expect(list[1].offers).toEqual([]);
  });
});
