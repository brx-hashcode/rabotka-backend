import { runMobileMoneySubFlow, getMobileMoneyInitialPayload } from '../mobile-money-subflow';

const makeProfile = () => ({
  id: 'profile-1',
  phone: '+242001234567',
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
    expect((payload._mm_options as any).contactUnlockAttemptId).toBe('unlock-1');
  });
});

describe('runMobileMoneySubFlow', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('step: use_registered_number', () => {
    it('option 1 moves to choose_operator with registered phone', async () => {
      const result = await runMobileMoneySubFlow(makeState('use_registered_number') as any, '1', makeProfile() as any, mockCtx);
      expect(result.nextState?.payload._mm_step).toBe('choose_operator');
      expect(result.nextState?.payload._mm_phone).toBe('+242001234567');
    });

    it('option 2 moves to enter_phone', async () => {
      const result = await runMobileMoneySubFlow(makeState('use_registered_number') as any, '2', makeProfile() as any, mockCtx);
      expect(result.nextState?.payload._mm_step).toBe('enter_phone');
    });

    it('option 3 returns fallback URL', async () => {
      const result = await runMobileMoneySubFlow(makeState('use_registered_number') as any, '3', makeProfile() as any, mockCtx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('pay.example.com');
    });

    it('invalid input shows prompt', async () => {
      const result = await runMobileMoneySubFlow(makeState('use_registered_number') as any, 'invalid', makeProfile() as any, mockCtx);
      expect(result.nextState?.payload._mm_step).toBe('use_registered_number');
    });
  });

  describe('step: enter_phone', () => {
    it('valid phone moves to choose_operator', async () => {
      const result = await runMobileMoneySubFlow(makeState('enter_phone') as any, '242001234567', makeProfile() as any, mockCtx);
      expect(result.nextState?.payload._mm_step).toBe('choose_operator');
    });

    it('invalid phone shows error', async () => {
      const result = await runMobileMoneySubFlow(makeState('enter_phone') as any, 'abc', makeProfile() as any, mockCtx);
      expect(result.reply[0]).toContain('invalide');
    });
  });

  describe('step: choose_operator', () => {
    const stateWithPhone = () => makeState('choose_operator', { _mm_phone: '+242001234567' });

    it('option 1 selects MTN and initiates payment', async () => {
      const result = await runMobileMoneySubFlow(stateWithPhone() as any, '1', makeProfile() as any, mockCtx);
      expect(result.clearState).toBe(true);
      expect(mockCtx.paymentService.initiateDirectPayment).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'CG_MTNMOBILEMONEY' })
      );
    });

    it('option 2 selects AIRTEL and initiates payment', async () => {
      const result = await runMobileMoneySubFlow(stateWithPhone() as any, '2', makeProfile() as any, mockCtx);
      expect(result.clearState).toBe(true);
      expect(mockCtx.paymentService.initiateDirectPayment).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'CG_AIRTELMONEY' })
      );
    });

    it('invalid input shows operator prompt', async () => {
      const result = await runMobileMoneySubFlow(stateWithPhone() as any, 'X', makeProfile() as any, mockCtx);
      expect(result.reply[0]).toContain('MTN');
    });

    it('shows fallback on payment failure', async () => {
      mockCtx.paymentService.initiateDirectPayment.mockResolvedValueOnce({ success: false });
      const result = await runMobileMoneySubFlow(stateWithPhone() as any, '1', makeProfile() as any, mockCtx);
      expect(result.clearState).toBe(true);
    });
  });

  describe('unexpected step', () => {
    it('resets to use_registered_number', async () => {
      const result = await runMobileMoneySubFlow(makeState('unknown_step') as any, 'anything', makeProfile() as any, mockCtx);
      expect(result.nextState?.payload._mm_step).toBe('use_registered_number');
    });
  });
});
