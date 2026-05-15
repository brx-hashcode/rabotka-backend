import {
  runAcceptRefuseCandidateFlow,
  getAcceptRefuseInitialState,
} from '../accept-refuse-candidate.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { AcceptRefuseContext } from '../accept-refuse-candidate.flow';
import { FLOW_IDS } from '../../bot.constants';

const APP_ID = 'app-1';
const EMPLOYER_ID = 'employer-1';

const employerProfile: BotProfile = {
  id: EMPLOYER_ID,
  first_name: 'Bob',
  last_name: 'Martin',
  phone: '+242000002',
  email: 'bob@example.com',
  profile_type: 'EMPLOYER',
  reliability_score: 100,
  status: 'ACTIVE',
};

const workerProfile: BotProfile = {
  ...employerProfile,
  profile_type: 'WORKER',
};

function makeCtx(
  overrides: Partial<AcceptRefuseContext> = {},
): AcceptRefuseContext {
  return {
    prisma: {} as AcceptRefuseContext['prisma'],
    applicationService: {
      accept: jest.fn().mockResolvedValue({}),
      reject: jest.fn().mockResolvedValue({}),
    } as unknown as AcceptRefuseContext['applicationService'],
    notificationService: {
      sendApplicationAcceptedToWorker: jest.fn().mockResolvedValue(undefined),
      sendApplicationRejectedToWorker: jest.fn().mockResolvedValue(undefined),
    } as unknown as AcceptRefuseContext['notificationService'],
    contactUnlockService: {
      getByApplicationId: jest.fn().mockResolvedValue(null),
    } as unknown as AcceptRefuseContext['contactUnlockService'],
    walletService: {} as AcceptRefuseContext['walletService'],
    systemConfigService: {} as AcceptRefuseContext['systemConfigService'],
    ...overrides,
  };
}

function makeState(
  applicationId: string,
  step = 1,
  extraPayload: Record<string, unknown> = {},
): BotState {
  return {
    flowId: FLOW_IDS.ACCEPT_REFUSE_CANDIDATE,
    step,
    payload: { applicationId, ...extraPayload },
    updatedAt: new Date().toISOString(),
  };
}

describe('runAcceptRefuseCandidateFlow()', () => {
  describe('guard checks', () => {
    it('returns error when applicationId is missing', async () => {
      const ctx = makeCtx();
      const state: BotState = {
        flowId: FLOW_IDS.ACCEPT_REFUSE_CANDIDATE,
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('Candidature non trouvée');
    });

    it('blocks worker from accepting/refusing', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('employeurs');
    });
  });

  describe('step 1', () => {
    it('shows action menu on empty input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 1);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '',
        employerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('Accepter');
    });

    it('accepts on "1" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 1);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '1',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(ctx.applicationService.accept).toHaveBeenCalledWith(
        APP_ID,
        EMPLOYER_ID,
      );
      expect(
        ctx.notificationService.sendApplicationAcceptedToWorker,
      ).toHaveBeenCalledWith(APP_ID);
    });

    it('accepts on "accepter" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 1);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        'Accepter',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('moves to step 2 on "2" (refuse)', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 1);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '2',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(2);
    });

    it('asks again for invalid input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 1);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        'xyz',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(1);
    });

    it('returns error message when accept throws', async () => {
      const ctx = makeCtx({
        applicationService: {
          accept: jest
            .fn()
            .mockRejectedValue(new Error('Offer already filled')),
        } as unknown as AcceptRefuseContext['applicationService'],
      });
      const state = makeState(APP_ID, 1);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '1',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Offer already filled');
    });
  });

  describe('step 2 — enter rejection reason', () => {
    it('moves to step 3 with reason', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 2);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        'Profil incomplet',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(3);
      expect(result.nextState?.payload.refusalReason).toBe('Profil incomplet');
    });

    it('moves to step 3 with null reason on "aucune"', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 2);
      const result = await runAcceptRefuseCandidateFlow(
        state,
        'aucune',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(3);
      expect(result.nextState?.payload.refusalReason).toBe('');
    });
  });

  describe('step 3 — confirm refusal', () => {
    it('rejects on "1" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 3, { refusalReason: 'Not qualified' });
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '1',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(ctx.applicationService.reject).toHaveBeenCalledWith(
        APP_ID,
        EMPLOYER_ID,
        'Not qualified',
      );
      expect(
        ctx.notificationService.sendApplicationRejectedToWorker,
      ).toHaveBeenCalledWith(APP_ID);
    });

    it('rejects with undefined reason when refusalReason is empty', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 3, { refusalReason: '' });
      await runAcceptRefuseCandidateFlow(state, '1', employerProfile, ctx);
      expect(ctx.applicationService.reject).toHaveBeenCalledWith(
        APP_ID,
        EMPLOYER_ID,
        undefined,
      );
    });

    it('cancels refusal on "2" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 3, { refusalReason: '' });
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '2',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('reste en attente');
    });

    it('asks again for invalid input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID, 3, { refusalReason: '' });
      const result = await runAcceptRefuseCandidateFlow(
        state,
        'maybe',
        employerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeUndefined();
    });

    it('returns error when reject throws', async () => {
      const ctx = makeCtx({
        applicationService: {
          reject: jest.fn().mockRejectedValue(new Error('Cannot reject')),
        } as unknown as AcceptRefuseContext['applicationService'],
      });
      const state = makeState(APP_ID, 3, { refusalReason: 'reason' });
      const result = await runAcceptRefuseCandidateFlow(
        state,
        '1',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Cannot reject');
    });
  });

  describe('getAcceptRefuseInitialState()', () => {
    it('returns correct initial state', () => {
      const state = getAcceptRefuseInitialState('app-99');
      expect(state.flowId).toBe(FLOW_IDS.ACCEPT_REFUSE_CANDIDATE);
      expect(state.step).toBe(1);
      expect(state.payload?.applicationId).toBe('app-99');
    });
  });
});
