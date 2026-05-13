import {
  runUnlockContactFlow,
  getUnlockContactInitialState,
  type UnlockContactContext,
} from '../unlock-contact.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { ContactUnlockStatus } from '@prisma/client';

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Jean',
  last_name: 'Dupont',
  phone: '+237600000001',
  email: 'jean@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const employerProfile: BotProfile = {
  ...workerProfile,
  id: 'employer-1',
  profile_type: 'EMPLOYER',
};

function makeState(overrides: Partial<BotState> = {}): BotState {
  return {
    flowId: FLOW_IDS.UNLOCK_CONTACT,
    step: 1,
    payload: {
      attemptId: 'attempt-1',
      otherName: 'Marie Martin',
      amount: 3000,
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<UnlockContactContext> = {},
): UnlockContactContext {
  return {
    contactUnlockService: {
      payUnlock: jest.fn().mockResolvedValue({
        attemptId: 'attempt-1',
        status: ContactUnlockStatus.PENDING_WORKER,
        newlyUnlocked: [],
      }),
      getContactsIfUnlocked: jest.fn().mockResolvedValue(null),
    } as unknown as UnlockContactContext['contactUnlockService'],
    walletService: {
      getProfileWalletBalance: jest.fn().mockResolvedValue(0),
    } as unknown as UnlockContactContext['walletService'],
    paymentService: {
      createPaymentUrl: jest
        .fn()
        .mockResolvedValue('https://example.com/pay/token-abc'),
      initiateDirectPayment: jest
        .fn()
        .mockResolvedValue({ success: true, gatewayRef: 'gw-ref-123' }),
    } as unknown as UnlockContactContext['paymentService'],
    botNotification: {
      sendContactUnlockedNotification: jest.fn().mockResolvedValue(undefined),
    } as unknown as UnlockContactContext['botNotification'],
    ...overrides,
  };
}

describe('runUnlockContactFlow()', () => {
  describe('guard checks', () => {
    it('returns menu on "menu" input', async () => {
      const result = await runUnlockContactFlow(
        makeState(),
        'menu',
        workerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/MENU/i);
    });

    it('returns error when attemptId is missing', async () => {
      const state: BotState = {
        flowId: FLOW_IDS.UNLOCK_CONTACT,
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      const result = await runUnlockContactFlow(
        state,
        '',
        workerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('introuvable');
    });
  });

  describe('step 1 — no input (prompt)', () => {
    it('shows unlock prompt when balance is 0', async () => {
      const ctx = makeCtx();
      const result = await runUnlockContactFlow(
        makeState(),
        '',
        workerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeFalsy();
      expect(ctx.walletService.getProfileWalletBalance).toHaveBeenCalledWith(
        'worker-1',
      );
    });

    it('shows wallet option when balance is sufficient', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
        } as unknown as UnlockContactContext['walletService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '',
        workerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('1'); // wallet option
    });
  });

  describe('step 1 — mobile money selection', () => {
    it('worker with no balance selects option 1 → enters mobile money sub-flow', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(0),
        } as unknown as UnlockContactContext['walletService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '1',
        workerProfile,
        ctx,
      );
      // Sub-flow starts: asks whether to use registered number
      expect(result.reply[0]).toContain('Mobile Money');
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeUndefined();
    });

    it('worker with balance selects option 2 → enters mobile money sub-flow', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
        } as unknown as UnlockContactContext['walletService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '2',
        workerProfile,
        ctx,
      );
      // Sub-flow starts: asks whether to use registered number
      expect(result.reply[0]).toContain('Mobile Money');
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeUndefined();
    });

    it('worker selects "later" option → clears state with reminder', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(0),
        } as unknown as UnlockContactContext['walletService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '2',
        workerProfile,
        ctx,
      );
      // option 2 with 0 balance is "later"
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/contact/);
    });
  });

  describe('step 1 — wallet credit', () => {
    it('pays by wallet, status PENDING_WORKER → shows waiting message', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
        } as unknown as UnlockContactContext['walletService'],
        contactUnlockService: {
          payUnlock: jest.fn().mockResolvedValue({
            attemptId: 'attempt-1',
            status: ContactUnlockStatus.PENDING_WORKER,
            newlyUnlocked: [],
          }),
          getContactsIfUnlocked: jest.fn().mockResolvedValue(null),
        } as unknown as UnlockContactContext['contactUnlockService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '1',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/employeur|travailleur/i);
      expect(
        ctx.botNotification.sendContactUnlockedNotification,
      ).not.toHaveBeenCalled();
    });

    it('pays by wallet, status UNLOCKED → shows contacts inline and notifies', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
        } as unknown as UnlockContactContext['walletService'],
        contactUnlockService: {
          payUnlock: jest.fn().mockResolvedValue({
            attemptId: 'attempt-1',
            status: ContactUnlockStatus.UNLOCKED,
            newlyUnlocked: [],
          }),
          getContactsIfUnlocked: jest.fn().mockResolvedValue({
            name: 'Marie Martin',
            phone: '+237600000002',
            email: 'marie@example.com',
          }),
        } as unknown as UnlockContactContext['contactUnlockService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '1',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(
        ctx.botNotification.sendContactUnlockedNotification,
      ).toHaveBeenCalledWith('attempt-1', {
        skipNotifyProfileId: workerProfile.id,
      });
      expect(result.reply[0]).toContain('Marie Martin');
    });

    it('wallet payment UNLOCKED — notifies cascaded attempts for multi-person jobs', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
        } as unknown as UnlockContactContext['walletService'],
        contactUnlockService: {
          payUnlock: jest.fn().mockResolvedValue({
            attemptId: 'attempt-1',
            status: ContactUnlockStatus.UNLOCKED,
            newlyUnlocked: ['attempt-2', 'attempt-3'],
          }),
          getContactsIfUnlocked: jest.fn().mockResolvedValue({
            name: 'Worker A',
            phone: '+237600000099',
            email: 'a@example.com',
          }),
        } as unknown as UnlockContactContext['contactUnlockService'],
      });
      await runUnlockContactFlow(makeState(), '1', employerProfile, ctx);
      const calls = (
        ctx.botNotification.sendContactUnlockedNotification as jest.Mock
      ).mock.calls;
      const attemptIds = calls.map((c) => c[0] as string);
      expect(attemptIds).toContain('attempt-1');
      expect(attemptIds).toContain('attempt-2');
      expect(attemptIds).toContain('attempt-3');
      for (const c of calls) {
        expect(c[1]).toEqual({ skipNotifyProfileId: employerProfile.id });
      }
    });

    it('handles payUnlock error gracefully', async () => {
      const ctx = makeCtx({
        walletService: {
          getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
        } as unknown as UnlockContactContext['walletService'],
        contactUnlockService: {
          payUnlock: jest
            .fn()
            .mockRejectedValue(new Error('Insufficient funds')),
          getContactsIfUnlocked: jest.fn(),
        } as unknown as UnlockContactContext['contactUnlockService'],
      });
      const result = await runUnlockContactFlow(
        makeState(),
        '1',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('Insufficient funds');
    });
  });

  describe('step 1 — unknown input re-prompts', () => {
    it('re-prompts on unrecognised input', async () => {
      const ctx = makeCtx();
      const result = await runUnlockContactFlow(
        makeState(),
        'xyz',
        workerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeFalsy();
    });
  });

  describe('getUnlockContactInitialState()', () => {
    it('returns correct initial state shape', () => {
      const state = getUnlockContactInitialState({
        attemptId: 'attempt-42',
        otherName: 'Test User',
        amount: 2500,
      });
      expect(state.flowId).toBe(FLOW_IDS.UNLOCK_CONTACT);
      expect(state.step).toBe(1);
      expect(state.payload.attemptId).toBe('attempt-42');
      expect(state.payload.otherName).toBe('Test User');
      expect(state.payload.amount).toBe(2500);
    });
  });
});
