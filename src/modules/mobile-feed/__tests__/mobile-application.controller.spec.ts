import { BadRequestException } from '@nestjs/common';
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

/**
 * On a multi-seat offer the employer's single payment cascades `employer_paid`
 * onto every candidate's attempt. Without a guard here the gateway would take
 * the money a second time: payUnlock rejects it afterwards and the throw is
 * swallowed downstream, so nothing unlocks and nothing is refunded.
 */
describe('MobileApplicationController — payMobile double-charge guard', () => {
  let controller: MobileApplicationController;
  let contactUnlock: { getByApplicationId: jest.Mock };
  let paymentRequest: { createPaymentUrl: jest.Mock };

  const buildController = (attempt: Record<string, unknown>) => {
    const prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ profile_type: ProfileType.EMPLOYER })
          .mockResolvedValue({ portfolio_slug: 'awa-m' }),
      },
    };
    const applicationService = {
      findById: jest.fn().mockResolvedValue(applicationRow()),
    };
    contactUnlock = {
      getByApplicationId: jest.fn().mockResolvedValue(attempt),
    };
    paymentRequest = {
      createPaymentUrl: jest
        .fn()
        .mockResolvedValue('https://pay.example/pay/tok-1'),
    };
    controller = new MobileApplicationController(
      prisma as never,
      applicationService as never,
      contactUnlock as never,
      {} as never,
      {} as never,
      paymentRequest as never,
    );
  };

  it('refuses to create a payment when the employer share is already settled', async () => {
    buildController({
      id: 'attempt-1',
      status: 'PENDING_WORKER',
      employer_amount: 500,
      employer_paid: true,
      worker_paid: false,
    });

    await expect(
      controller.payMobile(reqFor(EMPLOYER_ID) as never, APPLICATION_ID),
    ).rejects.toThrow(BadRequestException);
    expect(paymentRequest.createPaymentUrl).not.toHaveBeenCalled();
  });

  it('still creates a payment when the employer has not paid', async () => {
    buildController({
      id: 'attempt-1',
      status: 'PENDING_BOTH',
      employer_amount: 500,
      employer_paid: false,
      worker_paid: false,
    });

    const result = await controller.payMobile(
      reqFor(EMPLOYER_ID) as never,
      APPLICATION_ID,
    );

    expect(paymentRequest.createPaymentUrl).toHaveBeenCalled();
    expect(result).toEqual({ token: 'tok-1' });
  });
});
