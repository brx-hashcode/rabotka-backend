import { ConflictException } from '@nestjs/common';
import { ArchiveService } from '../archive.service';
import { ARCHIVE_REGISTRY } from '../archive.registry';

function makeDelegate() {
  return {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  };
}

function makePrisma() {
  const delegates: Record<string, ReturnType<typeof makeDelegate>> = {};
  for (const cfg of Object.values(ARCHIVE_REGISTRY)) {
    delegates[cfg.model] ??= makeDelegate();
  }
  return {
    ...delegates,
    // Interactive transaction: hand the same delegates back as `tx`, so the
    // test observes exactly what the transactional path does.
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(delegates)),
    __delegates: delegates,
  };
}

describe('ArchiveService', () => {
  let service: ArchiveService;
  let prisma: ReturnType<typeof makePrisma>;
  let cache: { invalidate: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    service = new ArchiveService(prisma as never, cache as never);
  });

  const profile = () => prisma.__delegates.profile;

  describe('restore()', () => {
    it('only ever touches rows that are actually archived', async () => {
      profile().updateMany.mockResolvedValue({ count: 2 });

      const res = await service.restore('profiles', ['a', 'b']);

      // The deleted_at guard is what stops restore from writing to a live row.
      expect(profile().updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, deleted_at: { not: null } },
        data: { deleted_at: null },
      });
      expect(res.count).toBe(2);
      // The admin must see their own restore immediately, not after the TTL.
      expect(cache.invalidate).toHaveBeenCalledWith('profiles');
    });

    it('is a no-op for an empty selection', async () => {
      expect(await service.restore('profiles', [])).toEqual({ count: 0 });
      expect(profile().updateMany).not.toHaveBeenCalled();
    });

    it('reports 0 when the ids were not archived', async () => {
      profile().updateMany.mockResolvedValue({ count: 0 });
      expect(await service.restore('profiles', ['live-row'])).toEqual({
        count: 0,
      });
    });
  });

  describe('purge()', () => {
    it('deletes when nothing blocks, and only archived rows', async () => {
      profile().count.mockResolvedValue(0);
      profile().deleteMany.mockResolvedValue({ count: 1 });

      const res = await service.purge('profiles', ['p1']);

      expect(profile().deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['p1'] }, deleted_at: { not: null } },
      });
      expect(res.count).toBe(1);
      expect(cache.invalidate).toHaveBeenCalledWith('profiles');
    });

    it('does not bust the cache when nothing was purged', async () => {
      profile().count.mockResolvedValue(0);
      profile().deleteMany.mockResolvedValue({ count: 0 });

      await service.purge('profiles', ['already-gone']);

      expect(cache.invalidate).not.toHaveBeenCalled();
    });

    it('refuses a profile that has payments, and says so', async () => {
      // First relation checked is `payments`.
      profile().count.mockImplementation(({ where }: never) =>
        Promise.resolve((where as Record<string, unknown>).payments ? 3 : 0),
      );

      await expect(service.purge('profiles', ['p1'])).rejects.toThrow(
        ConflictException,
      );
      expect(profile().deleteMany).not.toHaveBeenCalled();
    });

    it('carries the blocking counts back to the caller', async () => {
      profile().count.mockImplementation(({ where }: never) => {
        const w = where as Record<string, unknown>;
        if (w.payments) return Promise.resolve(3);
        if (w.payment_requests) return Promise.resolve(1);
        return Promise.resolve(0);
      });

      await expect(service.purge('profiles', ['p1'])).rejects.toMatchObject({
        response: {
          blockers: [
            { label: 'paiements', count: 3 },
            { label: 'demandes de paiement', count: 1 },
          ],
        },
      });
    });

    it('no longer keeps a profile for its KYC documents or welcome wallet', () => {
      // Every verified profile has KYC documents, and most a wallet holding
      // the welcome credit: blocking on those made profiles undeletable.
      const fields = new Set(
        ARCHIVE_REGISTRY.profiles.relations.map((r) => r.field),
      );
      expect(fields.has('kyc_documents')).toBe(false);
      expect(fields.has('kyc_verification_images')).toBe(false);

      const wallets = ARCHIVE_REGISTRY.profiles.relations.find(
        (r) => r.field === 'wallets',
      )!;
      const types = (
        wallets.where as { transactions: { some: { type: { in: string[] } } } }
      ).transactions.some.type.in;
      expect(types).toContain('TOP_UP_CREDIT');
      expect(types).toContain('CONTACT_UNLOCK_DEBIT');
      expect(types).not.toContain('WELCOME_CREDIT');
      expect(types).not.toContain('REFERRAL_CREDIT');
    });

    it('counts only the related rows the relation narrows to', async () => {
      await service.purge('profiles', ['p1']);

      const wheres = profile().count.mock.calls.map(
        ([arg]: [{ where: Record<string, unknown> }]) => arg.where,
      );
      // A pending unlock is no payment; a paid one is.
      expect(wheres).toContainEqual({
        id: { in: ['p1'] },
        unlock_attempts_as_employer: { some: { employer_paid: true } },
      });
      expect(wheres).toContainEqual({
        id: { in: ['p1'] },
        penalties: { some: { paid_at: { not: null } } },
      });
      // Without a narrowing, any row blocks — an attempted payment included.
      expect(wheres).toContainEqual({
        id: { in: ['p1'] },
        payments: { some: {} },
      });
    });

    it('reports both directions of a paid unlock as one line', async () => {
      profile().count.mockImplementation(({ where }: never) => {
        const w = where as Record<string, unknown>;
        if (w.unlock_attempts_as_employer) return Promise.resolve(2);
        if (w.unlock_attempts_as_worker) return Promise.resolve(1);
        return Promise.resolve(0);
      });

      await expect(service.purge('profiles', ['p1'])).rejects.toMatchObject({
        response: {
          blockers: [{ label: 'déblocages de contact payés', count: 3 }],
        },
      });
    });

    it('collects inside the transaction, before the rows are deleted', async () => {
      profile().deleteMany.mockResolvedValue({ count: 1 });
      const order: string[] = [];
      profile().deleteMany.mockImplementation(() => {
        order.push('delete');
        return Promise.resolve({ count: 1 });
      });
      const collect = jest.fn((tx: unknown, ids: string[]) => {
        order.push('collect');
        expect(tx).toBe(prisma.__delegates);
        return Promise.resolve(ids.map((id) => `file-of-${id}`));
      });

      const res = await service.purge('profiles', ['p1'], { collect });

      expect(order).toEqual(['collect', 'delete']);
      expect(res.collected).toEqual(['file-of-p1']);
    });

    it('never collects when a blocker refuses the purge', async () => {
      profile().count.mockImplementation(({ where }: never) =>
        Promise.resolve((where as Record<string, unknown>).payments ? 1 : 0),
      );
      const collect = jest.fn();

      await expect(
        service.purge('profiles', ['p1'], { collect }),
      ).rejects.toThrow(ConflictException);
      expect(collect).not.toHaveBeenCalled();
    });

    it('checks and deletes inside ONE transaction', async () => {
      // Otherwise a payment can land between the check and the cascade, and
      // the delete takes it with no trace.
      profile().count.mockResolvedValue(0);
      profile().deleteMany.mockResolvedValue({ count: 1 });

      await service.purge('profiles', ['p1']);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('blocks a settled penalty on its own state, not a relation', async () => {
      const penalty = prisma.__delegates.penalty;
      penalty.count.mockImplementation(({ where }: never) =>
        Promise.resolve(
          (where as Record<string, unknown>).paid_at ? 1 : 0,
        ),
      );

      await expect(service.purge('penalties', ['pen1'])).rejects.toMatchObject({
        response: {
          blockers: [{ label: 'pénalités déjà payées', count: 1 }],
        },
      });
      expect(penalty.deleteMany).not.toHaveBeenCalled();
    });

    it('never purges a wallet ledger entry', async () => {
      // selfBlocked.where is {}, so every row matches — the ledger is immutable.
      const wallet = prisma.__delegates.walletTransaction;
      wallet.count.mockResolvedValue(1);

      await expect(
        service.purge('wallet-transactions', ['tx1']),
      ).rejects.toThrow(ConflictException);
      expect(wallet.deleteMany).not.toHaveBeenCalled();
    });

    it('is a no-op for an empty selection', async () => {
      expect(await service.purge('profiles', [])).toEqual({ count: 0 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('purgeBlockers()', () => {
    it('reports without deleting anything', async () => {
      profile().count.mockImplementation(({ where }: never) =>
        Promise.resolve((where as Record<string, unknown>).invoices ? 2 : 0),
      );

      const blockers = await service.purgeBlockers('profiles', ['p1']);

      expect(blockers).toEqual([{ label: 'factures', count: 2 }]);
      expect(profile().deleteMany).not.toHaveBeenCalled();
    });

    it('returns nothing for a clean row', async () => {
      profile().count.mockResolvedValue(0);
      expect(await service.purgeBlockers('profiles', ['p1'])).toEqual([]);
    });
  });

  describe('registry', () => {
    it('guards every financial entity', () => {
      // A regression net: if someone adds an entity without deciding what
      // protects it, this fails rather than silently allowing a purge.
      for (const [key, cfg] of Object.entries(ARCHIVE_REGISTRY)) {
        const guarded = cfg.relations.length > 0 || cfg.selfBlocked != null;
        expect([key, guarded]).toEqual([key, true]);
      }
    });
  });
});
