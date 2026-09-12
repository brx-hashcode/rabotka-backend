import { AccountStatus } from '@prisma/client';
import { RecommendationContactService } from '../recommendation-contact.service';
import { ACCOUNT_NOT_ACTIVE } from '../../../common/exceptions/account-not-active.exception';

/**
 * The PAYING side's account status.
 *
 * `getActiveWorker` has always checked the worker being unlocked; the employer
 * doing the unlocking was checked nowhere, so a suspended employer kept
 * spending wallet credit for as long as their session lasted. The HTTP guard
 * covers the route, and this covers the service — a mobile-money payment can
 * settle long after the request that started it.
 */
describe('RecommendationContactService — employer account status', () => {
  const prisma = { profile: { findUnique: jest.fn(), findFirst: jest.fn() } };
  const systemConfig = { getRecommendationContactFee: jest.fn() };
  const wallet = { getOrCreateProfileWallet: jest.fn() };

  function makeService() {
    return new RecommendationContactService(
      prisma as never,
      wallet as never,
      systemConfig as never,
      {} as never, // invoice
      {} as never, // botNotification
      {} as never, // paymentRequest
      {} as never, // interactionEvents
      // contactRecords — the ledger. These cases all reject before any payment
      // is taken, so it must never be written to; a bare mock would pass
      // silently either way, so this one throws if the guard ever lets a
      // rejected call reach it.
      {
        record: jest.fn(() => {
          throw new Error('ledger written for a rejected contact unlock');
        }),
      } as never,
      {} as never, // whatsApp
      {} as never, // feedback
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it.each([['payWithWallet' as const], ['createMobilePaymentUrl' as const]])(
    'refuses %s for a suspended employer',
    async (method) => {
      prisma.profile.findUnique.mockResolvedValue({
        status: AccountStatus.SUSPENDED,
        suspension_reason: 'Trois pénalités impayées',
      });

      await expect(makeService()[method]('emp-1', 'w-1')).rejects.toMatchObject(
        {
          response: {
            code: ACCOUNT_NOT_ACTIVE,
            accountStatus: AccountStatus.SUSPENDED,
            reason: 'Trois pénalités impayées',
          },
        },
      );

      // Refused before anything is priced, looked up, or debited.
      expect(prisma.profile.findFirst).not.toHaveBeenCalled();
      expect(systemConfig.getRecommendationContactFee).not.toHaveBeenCalled();
      expect(wallet.getOrCreateProfileWallet).not.toHaveBeenCalled();
    },
  );

  it('lets an active employer past the status check', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.ACTIVE,
      suspension_reason: null,
    });
    // Stops the flow right after the check, at the worker lookup.
    prisma.profile.findFirst.mockResolvedValue(null);

    await expect(makeService().payWithWallet('emp-1', 'w-1')).rejects.toThrow(
      /plus actif/,
    );
    expect(prisma.profile.findFirst).toHaveBeenCalled();
  });
});
