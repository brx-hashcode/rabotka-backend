import {
  runMobileMoneySubFlow,
  getMobileMoneyInitialPayload,
} from '../mobile-money-subflow';

// Phone whose local prefix (06) maps to MTN per PREFIX_TO_OPERATOR
const makeProfile = (phone = '+242061234567') => ({
  id: 'profile-1',
  phone,
  first_name: 'Alice',
  last_name: 'Smith',
  profile_type: 'WORKER' as const,
  status: 'ACTIVE' as const,
  whatsapp_connected: true,
  billing_status: 'CLEAR' as const,
  penalties_count: 0,
});

const makeState = (step: string, extra: Record<string, unknown> = {}) => ({
  profileId: 'profile-1',
  flowId: 'PAYMENT',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  payload: {
    _mm_step: step,
    _mm_amount: 5000,
    _mm_description: 'Test payment',
    _mm_requestType: 'CONTACT_UNLOCK',
    _mm_options: {},
    ...extra,
  },
});

const mockCtx = {
  paymentService: {
    initiateDirectPayment: jest.fn().mockResolvedValue({ success: true }),
    createPaymentUrl: jest.fn(),
    generateActivationPaymentLink: jest.fn(),
    generateJobPostingPaymentLink: jest.fn(),
    generatePenaltyPaymentLink: jest.fn(),
    makePayment: jest.fn(),
    generateRecommendationContactPaymentLink: jest.fn(),
  },
  getFallbackUrl: jest.fn().mockResolvedValue('https://pay.example.com/pay'),
};

describe('getMobileMoneyInitialPayload', () => {
  it('returns initial payload with step use_registered_number', () => {
    const payload = getMobileMoneyInitialPayload({
      amount: 5000,
      description: 'Test',
      requestType: 'CONTACT_UNLOCK' as any,
    });
    expect(payload._mm_step).toBe('use_registered_number');
    expect(payload._mm_amount).toBe(5000);
    expect(payload._mm_options).toEqual({});
  });

  it('includes options when provided', () => {
    const payload = getMobileMoneyInitialPayload({
      amount: 1000,
      description: 'Test',
      requestType: 'CONTACT_UNLOCK' as any,
      options: { contactUnlockAttemptId: 'unlock-1' },
    });
    expect((payload._mm_options as any).contactUnlockAttemptId).toBe(
      'unlock-1',
    );
  });
});

describe('runMobileMoneySubFlow', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('step: use_registered_number', () => {
    it('option 1 with MTN-prefixed registered phone initiates payment directly', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('use_registered_number') as any,
        '1',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.clearState).toBe(true);
      expect(mockCtx.paymentService.initiateDirectPayment).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'CG_MTNMOBILEMONEY' }),
      );
    });

    it('option 1 with AIRTEL-prefixed registered phone initiates payment directly', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('use_registered_number') as any,
        '1',
        makeProfile('+242051234567') as any,
        mockCtx,
      );
      expect(result.clearState).toBe(true);
      expect(mockCtx.paymentService.initiateDirectPayment).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'CG_AIRTELMONEY' }),
      );
    });

    it('option 1 with unknown-prefix phone falls back to enter_phone step', async () => {
      const result = await runMobileMoneySubFlow(
        // 00 prefix is not in PREFIX_TO_OPERATOR
        makeState('use_registered_number') as any,
        '1',
        makeProfile('+242001234567') as any,
        mockCtx,
      );
      expect(result.nextState?.payload._mm_step).toBe('enter_phone');
      expect(
        mockCtx.paymentService.initiateDirectPayment,
      ).not.toHaveBeenCalled();
    });

    it('option 2 moves to enter_phone', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('use_registered_number') as any,
        '2',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.nextState?.payload._mm_step).toBe('enter_phone');
    });

    it('option 3 returns fallback URL', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('use_registered_number') as any,
        '3',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('pay.example.com');
    });

    it('invalid input shows prompt', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('use_registered_number') as any,
        'invalid',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.nextState?.payload._mm_step).toBe('use_registered_number');
    });
  });

  describe('step: enter_phone', () => {
    it('valid MTN phone auto-detects operator and initiates payment', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('enter_phone') as any,
        '061234567',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.clearState).toBe(true);
      expect(mockCtx.paymentService.initiateDirectPayment).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'CG_MTNMOBILEMONEY' }),
      );
    });

    it('valid AIRTEL phone auto-detects operator', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('enter_phone') as any,
        '051234567',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.clearState).toBe(true);
      expect(mockCtx.paymentService.initiateDirectPayment).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'CG_AIRTELMONEY' }),
      );
    });

    it('phone with unknown prefix shows operator-unknown message and stays in step', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('enter_phone') as any,
        '001234567',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.nextState?.payload._mm_step).toBe('enter_phone');
      expect(
        mockCtx.paymentService.initiateDirectPayment,
      ).not.toHaveBeenCalled();
    });

    it('invalid phone shows error', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('enter_phone') as any,
        'abc',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.reply[0]).toContain('invalide');
    });

    it('shows fallback on payment-service failure', async () => {
      mockCtx.paymentService.initiateDirectPayment.mockResolvedValueOnce({
        success: false,
      });
      const result = await runMobileMoneySubFlow(
        makeState('enter_phone') as any,
        '061234567',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.clearState).toBe(true);
      expect(mockCtx.getFallbackUrl).toHaveBeenCalled();
    });
  });

  describe('unexpected step', () => {
    it('resets to use_registered_number', async () => {
      const result = await runMobileMoneySubFlow(
        makeState('unknown_step') as any,
        'anything',
        makeProfile() as any,
        mockCtx,
      );
      expect(result.nextState?.payload._mm_step).toBe('use_registered_number');
    });
  });
});
