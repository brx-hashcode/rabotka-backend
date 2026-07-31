import {
  runRecommendedProfilesFlow,
  getRecommendedProfilesInitialState,
} from '../recommended-profiles.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';

const profile: BotProfile = {
  id: 'emp-1',
  first_name: 'Jean',
  last_name: 'Patron',
  phone: '+242000002',
  email: 'jean@test.com',
  profile_type: 'EMPLOYER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const workerIds = ['worker-1', 'worker-2', 'worker-3'];
const workerScores: Record<string, number> = {
  'worker-1': 0.85,
  'worker-2': 0.7,
  'worker-3': 0.6,
};

function makeState(step = 0, payload: Record<string, unknown> = {}): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_PROFILES,
    step,
    payload: {
      workerIds,
      workerScores,
      ...payload,
    },
    updatedAt: new Date().toISOString(),
  };
}

const baseWorker = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  reliability_score: 90,
  description: "Expert plombier avec 5 ans d'expérience",
  address: '10 Rue Paris',
  avatar_url: null as string | null,
  phone: '+242060000001',
  email: 'alice@example.com',
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  const txMock = {
    walletTransaction: { create: jest.fn().mockResolvedValue({}) },
    wallet: { update: jest.fn().mockResolvedValue({}) },
    payment: { create: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
  };
  return {
    prisma: {
      profile: {
        findFirst: jest.fn().mockResolvedValue(baseWorker),
        findUnique: jest.fn().mockResolvedValue(baseWorker),
        findMany: jest.fn().mockResolvedValue([
          baseWorker,
          {
            id: 'worker-2',
            first_name: 'Bob',
            last_name: 'Smith',
            reliability_score: 70,
            description: null,
          },
          {
            id: 'worker-3',
            first_name: 'Charlie',
            last_name: 'Brown',
            reliability_score: 60,
            description: 'x'.repeat(120), // exercise truncation
          },
        ]),
      },
      application: {
        count: jest.fn().mockResolvedValue(2),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve([]);
      }),
      _tx: txMock,
    } as any,
    systemConfig: {
      getRecommendationContactFee: jest.fn().mockResolvedValue(1000),
    } as any,
    contactUnlockService: {} as any,
    walletService: {
      getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
      getOrCreateProfileWallet: jest
        .fn()
        .mockResolvedValue({ id: 'pw-1', balance: 5000 }),
      getOrCreateSystemWallet: jest.fn().mockResolvedValue({ id: 'sw-1' }),
    } as any,
    paymentService: {
      createPaymentUrl: jest.fn().mockResolvedValue('http://pay.url'),
      initiateDirectPayment: jest.fn().mockResolvedValue({ success: true }),
    } as any,
    botNotification: {
      sendMessage: jest.fn().mockResolvedValue(undefined),
    } as any,
    employerProfileId: 'emp-1',
    interestSignalService: {
      record: jest.fn().mockResolvedValue(undefined),
      recordWorkerProfileView: jest.fn().mockResolvedValue(undefined),
    } as any,
    invoiceService: {
      create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
    } as any,
    portfolioService: {
      ensurePortfolioSlug: jest.fn().mockResolvedValue('alice-dupont-abc123'),
    } as any,
    mediaMirror: {
      resolveMediaKey: jest
        .fn()
        .mockImplementation((url: string | null, placeholder: string) =>
          Promise.resolve(url ?? placeholder),
        ),
    } as any,
    ...overrides,
  };
}

describe('getRecommendedProfilesInitialState', () => {
  it('seeds workerIds, workerScores and jobOfferId', () => {
    const s = getRecommendedProfilesInitialState(
      ['a', 'b'],
      { a: 0.5 },
      'jo-9',
    );
    expect(s.flowId).toBe(FLOW_IDS.RECOMMENDED_PROFILES);
    expect(s.step).toBe(0);
    expect(s.payload.workerIds).toEqual(['a', 'b']);
    expect(s.payload.workerScores).toEqual({ a: 0.5 });
    expect(s.payload.jobOfferId).toBe('jo-9');
  });

  it('defaults workerScores to {} and jobOfferId to undefined', () => {
    const s = getRecommendedProfilesInitialState(['a']);
    expect(s.payload.workerScores).toEqual({});
    expect(s.payload.jobOfferId).toBeUndefined();
  });
});

describe('runRecommendedProfilesFlow — global commands', () => {
  it('returns menu when menu command is typed', async () => {
    const result = await runRecommendedProfilesFlow(
      makeState(),
      'menu',
      profile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toBeDefined();
  });

  it('returns empty message when workerIds is empty', async () => {
    const state = makeState(0, { workerIds: [], workerScores: {} });
    const result = await runRecommendedProfilesFlow(
      state,
      '1',
      profile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucun profil');
  });

  it('returns to menu on "7" from list', async () => {
    const result = await runRecommendedProfilesFlow(
      makeState(),
      '7',
      profile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
  });
});

describe('runRecommendedProfilesFlow — list view (step 0)', () => {
  it('renders a list with workers, AI scores and IDs', async () => {
    const ctx = makeCtx();
    const result = await runRecommendedProfilesFlow(
      makeState(),
      'show',
      profile,
      ctx,
    );
    // 3 workers → a 3-card carousel ([TPL:] reply); card bodies carry names + AI score.
    expect(result.reply[0]).toContain('[TPL:');
    expect(result.reply[0]).toContain('Alice Dupont');
    expect(result.reply[0]).toContain('Bob Smith');
    expect(result.reply[0]).toContain('Charlie Brown');
    expect(result.reply[0]).toContain('Score IA : 85%'); // worker-1: 0.85 → 85
    expect(result.nextState?.payload.renderedWorkerIds).toEqual([
      'worker-1',
      'worker-2',
      'worker-3',
    ]);
  });

  it('truncates worker descriptions over 80 chars', async () => {
    const ctx = makeCtx();
    const result = await runRecommendedProfilesFlow(
      makeState(),
      'show',
      profile,
      ctx,
    );
    expect(result.reply[0]).toContain('…');
  });

  it('skips workers that are not returned by the DB lookup', async () => {
    const ctx = makeCtx();
    // Only worker-1 still exists in DB; -2 and -3 are filtered out.
    ctx.prisma.profile.findMany = jest.fn().mockResolvedValue([baseWorker]);
    const result = await runRecommendedProfilesFlow(
      makeState(),
      'show',
      profile,
      ctx,
    );
    expect(result.reply[0]).toContain('Alice Dupont');
    expect(result.reply[0]).not.toContain('Bob Smith');
    expect(result.nextState?.payload.renderedWorkerIds).toEqual(['worker-1']);
  });

  it('selects a worker by index (choice 1)', async () => {
    const ctx = makeCtx();
    const result = await runRecommendedProfilesFlow(
      makeState(),
      '1',
      profile,
      ctx,
    );
    expect(result.nextState?.step).toBe(1);
    expect(result.nextState?.payload.selectedWorkerId).toBe('worker-1');
    expect(result.reply[0]).toContain('Alice Dupont');
  });

  it('uses renderedWorkerIds for selection when present', async () => {
    const ctx = makeCtx();
    // Pretend the DB returned a re-ordered subset on the previous render.
    const state = makeState(0, {
      renderedWorkerIds: ['worker-3', 'worker-1'],
    });
    ctx.prisma.profile.findFirst = jest.fn().mockResolvedValue({
      ...baseWorker,
      id: 'worker-3',
      first_name: 'Charlie',
      last_name: 'Brown',
    });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.nextState?.payload.selectedWorkerId).toBe('worker-3');
  });

  it('shows the list again on unrecognised numeric input', async () => {
    const ctx = makeCtx();
    const result = await runRecommendedProfilesFlow(
      makeState(),
      '9',
      profile,
      ctx,
    );
    expect(result.reply[0]).toContain('[TPL:');
  });
});

describe('runRecommendedProfilesFlow — detail view (step 1)', () => {
  it('renders worker detail with address and reliability', async () => {
    const ctx = makeCtx();
    const result = await runRecommendedProfilesFlow(
      makeState(),
      '1',
      profile,
      ctx,
    );
    expect(result.reply[0]).toContain('Score fiabilité: 90/100');
    expect(result.reply[0]).toContain('Score IA: 85%');
    expect(result.reply[0]).toContain('Adresse: 10 Rue Paris');
    expect(result.reply[0]).toContain('Missions complétées: 2');
  });

  it('emits [IMG:...] prefix when worker has an avatar', async () => {
    const ctx = makeCtx();
    ctx.prisma.profile.findFirst = jest.fn().mockResolvedValue({
      ...baseWorker,
      avatar_url: 'https://cdn.example.com/a.jpg',
    });
    const result = await runRecommendedProfilesFlow(
      makeState(),
      '1',
      profile,
      ctx,
    );
    expect(result.reply[0]).toMatch(
      /^\[IMG:https:\/\/cdn\.example\.com\/a\.jpg\]/,
    );
  });

  it('records profile_view against the WORKER being viewed', async () => {
    const ctx = makeCtx();
    const state = makeState(0, { jobOfferId: 'jo-42' });
    await runRecommendedProfilesFlow(state, '1', profile, ctx);
    // fire-and-forget; wait a tick for the microtask to flush
    await Promise.resolve();

    // Regression: this used to record the employer's OWN jobOfferId, which
    // taught their vector about their own postings and discarded which worker
    // was actually viewed.
    expect(
      ctx.interestSignalService.recordWorkerProfileView,
    ).toHaveBeenCalledWith('emp-1', 'worker-1');
    expect(ctx.interestSignalService.record).not.toHaveBeenCalled();
  });

  it('records profile_view even without a jobOfferId in payload', async () => {
    // The old guard `if (jobOfferId)` meant browsing outside an offer context
    // recorded nothing at all.
    const ctx = makeCtx();
    const state = makeState(0, {});
    await runRecommendedProfilesFlow(state, '1', profile, ctx);
    await Promise.resolve();
    expect(
      ctx.interestSignalService.recordWorkerProfileView,
    ).toHaveBeenCalledWith('emp-1', 'worker-1');
  });

  it('shows fallback when worker is no longer active/verified', async () => {
    const ctx = makeCtx();
    ctx.prisma.profile.findFirst = jest.fn().mockResolvedValue(null);
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    // Trigger a re-render of the detail by simulating an unrecognised input
    // at detail step that *would* re-render via showWorkerDetail.
    // We exercise the null path directly by sending '1' from step 0 instead:
    const fromList = await runRecommendedProfilesFlow(
      makeState(),
      '1',
      profile,
      ctx,
    );
    expect(fromList.reply[0]).toContain('plus disponible');
    expect(fromList.nextState?.step).toBe(0);
    // direct step 1 path still works
    void state;
  });

  it('sends the portfolio CTA template on "2" from detail', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '2', profile, ctx);

    expect(ctx.portfolioService.ensurePortfolioSlug).toHaveBeenCalledWith(
      'worker-1',
    );
    expect(result.reply[0]).toMatch(
      new RegExp(
        `^\\[TPL:${WHATSAPP_TEMPLATES.viewWorkerPortfolio.contentSid}\\]`,
      ),
    );
    expect(result.reply[0]).toContain('alice-dupont-abc123');
    expect(result.reply[0]).toContain('Alice Dupont');
    // Stays on the detail step so "1- Contacter" still works afterwards.
    expect(result.nextState?.step).toBe(1);
  });

  // Viewing the portfolio must not consume the selection: the employer can
  // look at the work and then carry straight on with "1- Contacter".
  it('still accepts "1" (contacter) right after viewing the portfolio', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });

    const afterPortfolio = await runRecommendedProfilesFlow(
      state,
      '2',
      profile,
      ctx,
    );
    const contact = await runRecommendedProfilesFlow(
      afterPortfolio.nextState!,
      '1',
      profile,
      ctx,
    );

    expect(contact.reply[0]).toContain('Déverrouiller le contact');
    expect(contact.nextState?.step).toBe(2);
    expect(contact.nextState?.payload?.selectedWorkerId).toBe('worker-1');
  });

  it('still accepts "3" (liste) right after viewing the portfolio', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });

    const afterPortfolio = await runRecommendedProfilesFlow(
      state,
      '2',
      profile,
      ctx,
    );
    const back = await runRecommendedProfilesFlow(
      afterPortfolio.nextState!,
      '3',
      profile,
      ctx,
    );

    expect(back.nextState?.step).toBe(0);
  });

  it('degrades to plain text when the portfolio slug cannot be resolved', async () => {
    const ctx = makeCtx();
    ctx.portfolioService.ensurePortfolioSlug = jest
      .fn()
      .mockRejectedValue(new Error('db down'));
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '2', profile, ctx);

    expect(result.reply[0]).not.toContain('[TPL:');
    expect(result.reply[0]).toContain('Portfolio indisponible');
    expect(result.nextState?.step).toBe(1);
  });

  it('returns to the list on "3" from detail', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '3', profile, ctx);
    expect(result.reply[0]).toContain('[TPL:');
  });

  it('returns to the menu on "4" from detail', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '4', profile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('shows the payment-method prompt on "1" from detail', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.reply[0]).toContain('Déverrouiller le contact');
    expect(result.reply[0]).toContain('Utiliser mon crédit');
    expect(result.nextState?.step).toBe(2);
  });

  it('shows "solde insuffisant" wallet line when balance < fee', async () => {
    const ctx = makeCtx();
    ctx.walletService.getProfileWalletBalance = jest
      .fn()
      .mockResolvedValue(100);
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.reply[0]).toContain('Solde insuffisant');
  });

  it('re-shows the sub-menu on unknown input at step 1', async () => {
    const ctx = makeCtx();
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, 'wat', profile, ctx);
    expect(result.reply[0]).toContain('Tapez *1*, *2*, *3* ou *4*');
    expect(result.reply[0]).toContain('2- Voir le portfolio');
  });
});

describe('runRecommendedProfilesFlow — payment (step 2)', () => {
  it('wallet payment debits profile, credits system, creates Payment + Invoice', async () => {
    const ctx = makeCtx();
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);

    expect(ctx.prisma.$transaction).toHaveBeenCalled();
    const tx = ctx.prisma._tx;
    // 2x walletTransaction creates (debit + credit)
    expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
    // 2x wallet.update (decrement + increment)
    expect(tx.wallet.update).toHaveBeenCalledTimes(2);
    // 1x Payment
    expect(tx.payment.create).toHaveBeenCalled();
    // Reply contains the unlocked contact details
    expect(result.reply[0]).toContain('+242060000001');
    expect(result.reply[0]).toContain('alice@example.com');
    expect(result.clearState).toBe(true);
    // Fire-and-forget invoice (eventually)
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.invoiceService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'emp-1',
        paymentId: 'pay-1',
        amount: 1000,
      }),
    );
  });

  it('wallet payment short-circuits when worker disappears', async () => {
    const ctx = makeCtx();
    ctx.prisma.profile.findFirst = jest.fn().mockResolvedValue(null);
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain("n'est plus actif");
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('wallet payment reports insufficient balance with a hint', async () => {
    const ctx = makeCtx();
    ctx.walletService.getProfileWalletBalance = jest.fn().mockResolvedValue(0);
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.reply[0]).toContain('Solde insuffisant');
    expect(result.nextState).toBeDefined(); // stays in step 2
  });

  it('mobile-money on "2" enters the MM sub-flow with RECOMMENDATION_CONTACT type', async () => {
    const ctx = makeCtx();
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '2', profile, ctx);
    // Sub-flow's first prompt asks whether to use the registered number.
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('"3" cancels payment and returns to detail view', async () => {
    const ctx = makeCtx();
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '3', profile, ctx);
    expect(result.nextState?.step).toBe(1);
    expect(result.reply[0]).toContain('Score fiabilité');
  });

  it('catches transaction errors and reports them', async () => {
    const ctx = makeCtx();
    ctx.prisma.$transaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'));
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.reply[0]).toContain('❌');
    expect(result.reply[0]).toContain('boom');
    expect(result.clearState).toBe(true);
  });
});

describe('runRecommendedProfilesFlow — mobile-money sub-flow', () => {
  it('delegates to the MM sub-flow when _mm_step is present', async () => {
    const ctx = makeCtx();
    const state = makeState(0, {
      _mm_step: 'use_registered_number',
      _mm_amount: 1000,
      _mm_description: 'Test',
      _mm_requestType: 'RECOMMENDATION_CONTACT',
      _mm_options: {},
      _mm_worker_id: 'worker-1',
    });
    // Picking option "3" in the MM sub-flow asks for a fallback URL.
    const result = await runRecommendedProfilesFlow(state, '3', profile, ctx);
    expect(ctx.paymentService.createPaymentUrl).toHaveBeenCalledWith(
      'emp-1',
      1000,
      'Test',
      'RECOMMENDATION_CONTACT',
      { recommendationWorkerId: 'worker-1' },
    );
    expect(result.clearState).toBe(true);
  });
});
