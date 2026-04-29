import { runApplyJobFlow, getApplyJobInitialState } from '../apply-job.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { ApplyJobContext } from '../apply-job.flow';
import { FLOW_IDS } from '../../bot.constants';

const mockOffer = {
  id: 'offer-1',
  title: 'Plombier',
  description: 'Réparation fuite eau cuisine, remplacement robinet.',
  scheduled_at: new Date('2026-06-01T10:00:00Z'),
  amount: 15000,
  payment_flow: 'DAILY',
  address: '10 Rue de la Paix',
  note: null as string | null,
  quantity: 1,
  status: 'ACTIVE',
  acceptedCount: 0,
  employer_id: 'emp-1',
  created_at: new Date(),
  employer: { reliability_score: 80 as number | null },
};

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const employerProfile: BotProfile = {
  ...workerProfile,
  profile_type: 'EMPLOYER',
};

function makeCtx(overrides: Partial<ApplyJobContext> = {}): ApplyJobContext {
  return {
    applicationService: {
      create: jest.fn().mockResolvedValue({ id: 'app-1' }),
      getUnpaidPenalties: jest.fn().mockResolvedValue({ count: 0, total: 0 }),
    } as unknown as ApplyJobContext['applicationService'],
    jobOfferService: {
      findById: jest.fn().mockResolvedValue(mockOffer),
    } as unknown as ApplyJobContext['jobOfferService'],
    notificationService: {
      sendNewApplicationToEmployer: jest.fn().mockResolvedValue(undefined),
    } as unknown as ApplyJobContext['notificationService'],
    systemConfigService: {
      getFees: jest.fn().mockResolvedValue({
        lateCancellationPenaltyFcfa: 5000,
        lateCancellationScoreDeduction: 5,
        cancellationThresholdHours: 4,
        reliabilityScoreMin: 50,
        employerCancelScoreDeduction: 5,
        employerGhostScoreDeduction: 10,
        billingBlockThreshold: 2,
      }),
      getRaw: jest.fn().mockResolvedValue('5000'),
      getContactInfo: jest.fn().mockResolvedValue({
        orangeMoneyNumber: '',
        airtelMoneyNumber: '',
      }),
    } as unknown as ApplyJobContext['systemConfigService'],
    ...overrides,
  };
}

function makeState(jobOfferId: string, step = 1): BotState {
  return {
    flowId: FLOW_IDS.APPLY_JOB,
    step,
    payload: { jobOfferId },
    updatedAt: new Date().toISOString(),
  };
}

describe('runApplyJobFlow()', () => {
  describe('guard checks', () => {
    it('returns menu message on "menu" input', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1');
      const result = await runApplyJobFlow(state, 'menu', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/MENU/i);
    });

    it('returns error when jobOfferId is missing', async () => {
      const ctx = makeCtx();
      const state: BotState = {
        flowId: FLOW_IDS.APPLY_JOB,
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      const result = await runApplyJobFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('OFFRE NON TROUVÉE');
    });

    it('blocks employer from applying', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1');
      const result = await runApplyJobFlow(state, '', employerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('WORKERS');
    });

    it('blocks worker with unpaid penalties', async () => {
      const ctx = makeCtx({
        applicationService: {
          create: jest.fn(),
          getUnpaidPenalties: jest
            .fn()
            .mockResolvedValue({ count: 2, total: 10000 }),
        } as unknown as ApplyJobContext['applicationService'],
      });
      const state = makeState('offer-1');
      const result = await runApplyJobFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('returns error when offer is not found', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findById: jest.fn().mockResolvedValue(null),
        } as unknown as ApplyJobContext['jobOfferService'],
      });
      const state = makeState('offer-1');
      const result = await runApplyJobFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain("N'EXISTE PLUS");
    });
  });

  describe('step 1', () => {
    it('shows confirmation when input is empty', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(state, '', workerProfile, ctx);
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('Plombier');
    });

    it('creates application on "1" input', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(ctx.applicationService.create).toHaveBeenCalledWith(
        'offer-1',
        'worker-1',
      );
      expect(
        ctx.notificationService.sendNewApplicationToEmployer,
      ).toHaveBeenCalledWith('app-1');
    });

    it('creates application on "oui" input', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(state, 'oui', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(ctx.applicationService.create).toHaveBeenCalled();
    });

    it('returns without applying on "2" (no prior candidature)', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(state, '2', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('pas postulé');
      expect(result.reply[0]).not.toContain('ANNULÉE');
    });

    it('returns without applying on "non" input', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(state, 'non', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('pas postulé');
    });

    it('on "2" restores list-offers detail when returnToListOffers is set', async () => {
      const ctx = makeCtx();
      const state: BotState = {
        flowId: FLOW_IDS.APPLY_JOB,
        step: 1,
        payload: {
          jobOfferId: 'offer-1',
          returnToListOffers: {
            offerIds: ['x', 'y', 'offer-1'],
            nextCursor: 'c1',
            selectedOfferIndex: 2,
          },
        },
        updatedAt: new Date().toISOString(),
      };
      const result = await runApplyJobFlow(state, '2', workerProfile, ctx);
      expect(result.clearState).toBeUndefined();
      expect(result.nextState?.flowId).toBe(FLOW_IDS.LIST_OFFERS);
      expect(result.nextState?.payload).toMatchObject({
        step: 'detail',
        selectedOfferIndex: 2,
        offerIds: ['x', 'y', 'offer-1'],
        nextCursor: 'c1',
      });
      expect(result.reply[0]).toContain('Plombier');
      expect(result.reply[0]).toContain('Postuler');
    });

    it('asks again for unknown input', async () => {
      const ctx = makeCtx();
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(
        state,
        'whatever',
        workerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeUndefined();
    });

    it('returns error message when application.create throws', async () => {
      const ctx = makeCtx({
        applicationService: {
          create: jest.fn().mockRejectedValue(new Error('Already applied')),
          getUnpaidPenalties: jest
            .fn()
            .mockResolvedValue({ count: 0, total: 0 }),
        } as unknown as ApplyJobContext['applicationService'],
      });
      const state = makeState('offer-1', 1);
      const result = await runApplyJobFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('Already applied');
    });
  });

  describe('getApplyJobInitialState()', () => {
    it('returns initial state with correct flowId and step', () => {
      const state = getApplyJobInitialState('offer-99');
      expect(state.flowId).toBe(FLOW_IDS.APPLY_JOB);
      expect(state.step).toBe(1);
      expect(state.payload?.jobOfferId).toBe('offer-99');
    });

    it('stores returnToListOffers when provided', () => {
      const ret = {
        offerIds: ['a', 'b'],
        nextCursor: 'c',
        selectedOfferIndex: 1,
      };
      const state = getApplyJobInitialState('offer-99', ret);
      expect(state.payload?.returnToListOffers).toEqual(ret);
    });
  });
});
