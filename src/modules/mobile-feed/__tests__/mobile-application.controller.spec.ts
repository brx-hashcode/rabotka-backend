import { ProfileType } from '@prisma/client';
import { MobileApplicationController } from '../mobile-application.controller';

type Req = { user: { profileId: string } };
const reqFor = (profileId: string): Req => ({ user: { profileId } });

const EMPLOYER_ID = 'employer-1';
const APPLICATION_ID = 'application-1';

const applicationRow = () => ({
  id: APPLICATION_ID,
  worker_id: 'worker-1',
  status: 'PENDING',
  job_offer: { id: 'offer-1', employer_id: EMPLOYER_ID, status: 'ACTIVE' },
});

/**
 * The employer needs to know what accepting will cost *before* committing to
 * it, but the unlock attempt (and so the real fee) only exists after the
 * acceptance. `buildDetail` therefore quotes the configured fee while no
 * attempt exists, and stops quoting once one does.
 */
describe('MobileApplicationController — pre-acceptance quote', () => {
  let controller: MobileApplicationController;
  let prisma: { profile: { findUnique: jest.Mock } };
  let applicationService: { findById: jest.Mock };
  let contactUnlock: { getByApplicationId: jest.Mock };
  let systemConfig: { getContactUnlockFees: jest.Mock };
  let wallet: { getProfileWalletBalance: jest.Mock };

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          // assertEmployer, then the portfolio_slug lookup in buildDetail.
          .mockResolvedValueOnce({ profile_type: ProfileType.EMPLOYER })
          .mockResolvedValue({ portfolio_slug: 'awa-m' }),
      },
    };
    applicationService = {
      findById: jest.fn().mockResolvedValue(applicationRow()),
    };
    contactUnlock = { getByApplicationId: jest.fn().mockResolvedValue(null) };
    systemConfig = {
      getContactUnlockFees: jest.fn().mockResolvedValue({
        employerFeeFcfa: 500,
        workerFeeFcfa: 100,
        expiryHours: 48,
      }),
    };
    wallet = { getProfileWalletBalance: jest.fn().mockResolvedValue(1200) };

    controller = new MobileApplicationController(
      prisma as never,
      applicationService as never,
      contactUnlock as never,
      systemConfig as never,
      wallet as never,
      {} as never,
    );
  });

  it('quotes the fee and balance while no unlock attempt exists', async () => {
    const detail = await controller.getDetail(
      reqFor(EMPLOYER_ID) as never,
      APPLICATION_ID,
    );

    expect(detail.unlock).toBeNull();
    expect(detail.quote).toEqual({ employerFee: 500, walletBalance: 1200 });
  });

  it('stops quoting once the attempt carries the real amount', async () => {
    contactUnlock.getByApplicationId.mockResolvedValue({
      id: 'attempt-1',
      status: 'PENDING_BOTH',
      employer_amount: 500,
      expires_at: new Date(),
      employer_paid: false,
      worker_paid: false,
    });

    const detail = await controller.getDetail(
      reqFor(EMPLOYER_ID) as never,
      APPLICATION_ID,
    );

    // A prospective quote alongside a committed amount would only be ambiguous.
    expect(detail.quote).toBeNull();
    expect(detail.unlock).toMatchObject({ employerFee: 500 });
    expect(systemConfig.getContactUnlockFees).not.toHaveBeenCalled();
  });
});
