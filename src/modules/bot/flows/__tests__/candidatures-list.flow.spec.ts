import {
  runCandidaturesListFlow,
  getCandidaturesListInitialState,
} from '../candidatures-list.flow';
import type { BotProfile } from '../../types/bot-state.types';
import type { CandidatureListItem } from '../../messages/application.messages';
import { FLOW_IDS } from '../../bot.constants';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';

const employerProfile: BotProfile = {
  id: 'e-1',
  first_name: 'Jean',
  last_name: 'Patron',
  phone: '+24200000002',
  email: 'jean@example.com',
  profile_type: 'EMPLOYER',
  reliability_score: null,
  status: 'ACTIVE',
};

function makeItem(id: string, name = 'Alice Dupont'): CandidatureListItem {
  const [firstName, lastName] = name.split(' ');
  return {
    id,
    workerId: `worker-of-${id}`,
    fullName: name,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}@example.com`,
    score: 90,
    status: 'VERIFIED',
    offerTitle: 'Plombier',
  };
}

function makeItems(count: number): CandidatureListItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem(`app-${i + 1}`, `Worker${i + 1} Nom`),
  );
}

function makeCtx() {
  return {
    prisma: {
      application: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ worker_id: 'worker-from-db' }),
      },
    } as any,
    applicationService: {
      markAsViewed: jest.fn().mockResolvedValue(undefined),
      accept: jest.fn().mockResolvedValue(undefined),
      reject: jest.fn().mockResolvedValue(undefined),
    } as any,
    notificationService: {
      sendApplicationAcceptedToWorker: jest.fn().mockResolvedValue(undefined),
      sendApplicationRejectedToWorker: jest.fn().mockResolvedValue(undefined),
    } as any,
    contactUnlockService: {
      getByApplicationId: jest.fn().mockResolvedValue(null),
    } as any,
    walletService: {} as any,
    systemConfigService: {} as any,
    portfolioService: {
      ensurePortfolioSlug: jest.fn().mockResolvedValue('alice-dupont-abc123'),
    } as any,
  };
}

describe('runCandidaturesListFlow()', () => {
  it('returns no-items message when items list is empty', async () => {
    const state = getCandidaturesListInitialState([]);
    const result = await runCandidaturesListFlow(
      state,
      '',
      employerProfile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucune candidature');
  });

  it('exits to menu on "menu" command', async () => {
    const state = getCandidaturesListInitialState(makeItems(3));
    const result = await runCandidaturesListFlow(
      state,
      'menu',
      employerProfile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
  });

  it('exits to menu on "7"', async () => {
    const state = getCandidaturesListInitialState(makeItems(3));
    const result = await runCandidaturesListFlow(
      state,
      '7',
      employerProfile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
  });

  it('shows detail on selecting item "1"', async () => {
    const state = getCandidaturesListInitialState(makeItems(3));
    const result = await runCandidaturesListFlow(
      state,
      '1',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState?.payload?.step).toBe('detail');
    expect(result.nextState?.payload?.selectedApplicationId).toBe('app-1');
  });

  it('shows error for out-of-range selection', async () => {
    const state = getCandidaturesListInitialState(makeItems(3));
    const result = await runCandidaturesListFlow(
      state,
      '9',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState).toBe(state);
  });

  it('paginates to next page on "6"', async () => {
    const state = getCandidaturesListInitialState(makeItems(8));
    const result = await runCandidaturesListFlow(
      state,
      '6',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState?.payload?.pageIndex).toBe(1);
  });

  it('shows error when "6" pressed but no more items', async () => {
    const state = getCandidaturesListInitialState(makeItems(3));
    const result = await runCandidaturesListFlow(
      state,
      '6',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState).toBe(state);
    expect(result.reply[0]).toContain('Tapez');
  });

  describe('step: detail', () => {
    function makeDetailState(item: CandidatureListItem) {
      return {
        flowId: FLOW_IDS.CANDIDATURES_LIST,
        step: 1,
        payload: {
          items: [item],
          pageIndex: 0,
          step: 'detail',
          selectedApplicationId: item.id,
          selectedItem: item,
        },
        updatedAt: new Date().toISOString(),
      };
    }

    it('exits to menu on "4"', async () => {
      const item = makeItem('app-1');
      const state = makeDetailState(item);
      const result = await runCandidaturesListFlow(
        state,
        '4',
        employerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });

    it('returns to list on "3"', async () => {
      const item = makeItem('app-1');
      const state = makeDetailState(item);
      const result = await runCandidaturesListFlow(
        state,
        '3',
        employerProfile,
        makeCtx(),
      );
      expect(result.nextState?.payload?.step).toBe('list');
    });

    it('initiates accept/refuse on "1"', async () => {
      const item = makeItem('app-1');
      const state = makeDetailState(item);
      const result = await runCandidaturesListFlow(
        state,
        '1',
        employerProfile,
        makeCtx(),
      );
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('sends the portfolio CTA template on "5"', async () => {
      const item = makeItem('app-1');
      const state = makeDetailState(item);
      const ctx = makeCtx();
      const result = await runCandidaturesListFlow(
        state,
        '5',
        employerProfile,
        ctx,
      );

      expect(ctx.portfolioService.ensurePortfolioSlug).toHaveBeenCalledWith(
        'worker-of-app-1',
      );
      expect(result.reply[0]).toMatch(
        new RegExp(
          `^\\[TPL:${WHATSAPP_TEMPLATES.viewWorkerPortfolio.contentSid}\\]`,
        ),
      );
      expect(result.reply[0]).toContain('alice-dupont-abc123');
      // Detail step preserved so accept/refuse still works afterwards.
      expect(result.nextState).toBe(state);
    });

    // Same guarantee as the recommended-profiles flow: looking at the
    // portfolio does not consume the selection.
    it('still accepts "1" (accepter) right after viewing the portfolio', async () => {
      const item = makeItem('app-1');
      const state = makeDetailState(item);
      const ctx = makeCtx();

      const afterPortfolio = await runCandidaturesListFlow(
        state,
        '5',
        employerProfile,
        ctx,
      );
      const accepted = await runCandidaturesListFlow(
        afterPortfolio.nextState!,
        '1',
        employerProfile,
        ctx,
      );

      expect(accepted.reply.length).toBeGreaterThan(0);
      expect(ctx.applicationService.markAsViewed).toBeDefined();
    });

    it('falls back to the application when a stored item has no workerId', async () => {
      // Items persisted in bot state before workerId existed.
      const { workerId: _omitted, ...legacyItem } = makeItem('app-1');
      const state = makeDetailState(legacyItem as CandidatureListItem);
      const ctx = makeCtx();
      const result = await runCandidaturesListFlow(
        state,
        '5',
        employerProfile,
        ctx,
      );

      expect(ctx.prisma.application.findUnique).toHaveBeenCalled();
      expect(ctx.portfolioService.ensurePortfolioSlug).toHaveBeenCalledWith(
        'worker-from-db',
      );
      expect(result.reply[0]).toContain('[TPL:');
    });

    it('degrades to plain text when the applicant cannot be resolved', async () => {
      const { workerId: _omitted, ...legacyItem } = makeItem('app-1');
      const state = makeDetailState(legacyItem as CandidatureListItem);
      const ctx = makeCtx();
      ctx.prisma.application.findUnique = jest.fn().mockResolvedValue(null);
      const result = await runCandidaturesListFlow(
        state,
        '5',
        employerProfile,
        ctx,
      );

      expect(result.reply[0]).not.toContain('[TPL:');
      expect(result.reply[0]).toContain('Portfolio indisponible');
    });
  });
});

describe('getCandidaturesListInitialState()', () => {
  it('creates state with correct flowId and items', () => {
    const items = makeItems(2);
    const state = getCandidaturesListInitialState(items);
    expect(state.flowId).toBe(FLOW_IDS.CANDIDATURES_LIST);
    expect(state.payload?.items).toBe(items);
    expect(state.payload?.pageIndex).toBe(0);
    expect(state.step).toBe(0);
  });
});
