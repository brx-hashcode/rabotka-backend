import { isWorkerHardBlocked } from '../penalty.utils';

/**
 * Pentest A2-F03 (#859): an archived unpaid penalty still hard-blocked the
 * worker. Archived means waived: it is not owed.
 */
describe('isWorkerHardBlocked', () => {
  it('only counts unpaid penalties that are not archived', async () => {
    const count = jest.fn().mockResolvedValue(0);

    await expect(
      isWorkerHardBlocked({ penalty: { count } } as never, 'w-1', 3),
    ).resolves.toBe(false);

    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        profile_id: 'w-1',
        paid_at: null,
        deleted_at: null,
      }),
    });
  });
});
