import {
  runVerifyWhatsappFlow,
  getVerifyWhatsappInitialState,
} from '../verify-whatsapp.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const profile: BotProfile = {
  id: 'profile-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

function makeState(): BotState {
  return {
    flowId: FLOW_IDS.VERIFY_WHATSAPP,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

const now = new Date();
const future = new Date(now.getTime() + 3600000);
const past = new Date(now.getTime() - 3600000);

const mockToken = {
  id: 'token-1',
  token: 'ABC123',
  profile_id: 'profile-1',
  expires_at: future,
  used_at: null,
};

function makeCtx(tokenOverrides: any = null) {
  const mockPrisma: any = {
    verificationToken: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          tokenOverrides === null ? null : { ...mockToken, ...tokenOverrides },
        ),
      update: jest.fn().mockResolvedValue({}),
    },
    profile: {
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockResolvedValue([{}, {}]),
  };

  return {
    prisma: mockPrisma,
    walletService: {
      grantWelcomeCredit: jest.fn().mockResolvedValue(5000),
      getOrCreateProfileWallet: jest.fn().mockResolvedValue({ balance: 5000 }),
    } as any,
    systemConfigService: {} as any,
  };
}

describe('runVerifyWhatsappFlow', () => {
  it('returns verification prompt when input is empty', async () => {
    const ctx = makeCtx();
    const result = await runVerifyWhatsappFlow(makeState(), '', profile, ctx);
    expect(result.nextState?.flowId).toBe(FLOW_IDS.VERIFY_WHATSAPP);
  });

  it('returns error when token not found', async () => {
    const ctx = makeCtx(null);
    ctx.prisma.verificationToken.findFirst.mockResolvedValue(null);
    const result = await runVerifyWhatsappFlow(
      makeState(),
      'WRONG',
      profile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
    expect(result.reply[0]).toContain('incorrect');
  });

  it('returns error when token is expired', async () => {
    const ctx = makeCtx({ expires_at: past });
    const result = await runVerifyWhatsappFlow(
      makeState(),
      'ABC123',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('expiré');
  });

  it('returns error when token already used', async () => {
    const ctx = makeCtx({ used_at: past });
    const result = await runVerifyWhatsappFlow(
      makeState(),
      'ABC123',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('utilisé');
  });

  it('verifies successfully with valid token', async () => {
    const ctx = makeCtx({});
    const result = await runVerifyWhatsappFlow(
      makeState(),
      'ABC123',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(ctx.walletService.grantWelcomeCredit).toHaveBeenCalled();
  });

  it('tracks failed attempt count in state', async () => {
    const ctx = makeCtx(null);
    ctx.prisma.verificationToken.findFirst.mockResolvedValue(null);
    const result = await runVerifyWhatsappFlow(makeState(), 'WRONG', profile, ctx);
    expect(result.nextState?.payload?.attempts).toBe(1);
    expect(result.clearState).toBeFalsy();
  });

  it('blocks after 5 failed attempts', async () => {
    const ctx = makeCtx(null);
    ctx.prisma.verificationToken.findFirst.mockResolvedValue(null);
    const stateWith5Failures: BotState = {
      flowId: FLOW_IDS.VERIFY_WHATSAPP,
      step: 1,
      payload: { attempts: 5 },
      updatedAt: new Date().toISOString(),
    };
    const result = await runVerifyWhatsappFlow(stateWith5Failures, 'WRONG', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('support');
    // Must not even reach DB lookup on 6th attempt
    expect(ctx.prisma.verificationToken.findFirst).not.toHaveBeenCalled();
  });

  it('handles wallet error gracefully', async () => {
    const ctx = makeCtx({});
    ctx.walletService.grantWelcomeCredit.mockRejectedValue(
      new Error('Wallet error'),
    );
    ctx.walletService.getOrCreateProfileWallet.mockRejectedValue(
      new Error('Wallet error'),
    );
    const result = await runVerifyWhatsappFlow(
      makeState(),
      'ABC123',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
  });
});

describe('getVerifyWhatsappInitialState', () => {
  it('returns initial state', () => {
    const state = getVerifyWhatsappInitialState();
    expect(state.flowId).toBe(FLOW_IDS.VERIFY_WHATSAPP);
    expect(state.step).toBe(1);
  });
});
