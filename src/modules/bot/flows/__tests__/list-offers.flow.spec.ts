import { runListOffersFlow, getListOffersInitialState } from '../list-offers.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { JobOfferService } from '../../../job-offer/job-offer.service';
import { FLOW_IDS } from '../../bot.constants';

const OFFER_IDS = ['offer-1', 'offer-2', 'offer-3', 'offer-4', 'offer-5'];

function makeState(payload: Record<string, unknown>): BotState {
  return {
    flowId: FLOW_IDS.LIST_OFFERS,
    step: 0,
    payload,
    updatedAt: new Date().toISOString(),
  };
}

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Jane',
  last_name: 'Doe',
  profile_type: 'WORKER',
  status: 'ACTIVE',
  phone: '+242111111',
};

function makeOffer(id: string) {
  return {
    id,
    title: `Offre ${id}`,
    description: 'Description de l\'offre disponible pour test',
    scheduled_at: new Date(Date.now() + 5 * 3600000),
    amount: 15000,
    payment_flow: 'DAILY',
    address: '123 Avenue de la Paix, Brazzaville',
    note: null,
    quantity: 2,
    status: 'ACTIVE',
    employer_id: 'employer-1',
    created_at: new Date(),
  };
}

const mockJobOfferService = {
  findActive: jest.fn(),
  findById: jest.fn(),
} as unknown as jest.Mocked<JobOfferService>;

const ctx = { jobOfferService: mockJobOfferService };

beforeEach(() => {
  jest.clearAllMocks();
  OFFER_IDS.forEach((id) => {
    (mockJobOfferService.findById as jest.Mock).mockResolvedValue(makeOffer(id));
  });
});

describe('getListOffersInitialState()', () => {
  it('creates correct initial state', () => {
    const state = getListOffersInitialState(OFFER_IDS, 'cursor-1');
    expect(state.flowId).toBe(FLOW_IDS.LIST_OFFERS);
    expect(state.payload.offerIds).toEqual(OFFER_IDS);
    expect(state.payload.nextCursor).toBe('cursor-1');
  });
});

describe('runListOffersFlow()', () => {
  describe('list step', () => {
    const listPayload = { offerIds: OFFER_IDS, step: 'list' };

    it('returns error when offer list is empty', async () => {
      const state = makeState({ offerIds: [], step: 'list' });
      const result = await runListOffersFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('selects offer 1 and shows detail', async () => {
      const state = makeState(listPayload);
      const result = await runListOffersFlow(state, '1', workerProfile, ctx);
      expect(result.nextState?.payload.step).toBe('detail');
      expect(result.nextState?.payload.selectedOfferIndex).toBe(0);
    });

    it('selects offer 3 and shows detail', async () => {
      const state = makeState(listPayload);
      const result = await runListOffersFlow(state, '3', workerProfile, ctx);
      expect(result.nextState?.payload.selectedOfferIndex).toBe(2);
    });

    it('loads more when input is "6" and cursor exists', async () => {
      const stateWithCursor = makeState({
        ...listPayload,
        nextCursor: 'cursor-abc',
      });
      (mockJobOfferService.findActive as jest.Mock).mockResolvedValue({
        data: [makeOffer('offer-6')],
        nextCursor: null,
      });
      const result = await runListOffersFlow(stateWithCursor, '6', workerProfile, ctx);
      expect(mockJobOfferService.findActive).toHaveBeenCalledWith(
        5,
        'cursor-abc',
        workerProfile.id,
      );
      expect(result.nextState?.payload.offerIds).toContain('offer-6');
    });

    it('goes to menu when input is "7"', async () => {
      const state = makeState(listPayload);
      const result = await runListOffersFlow(state, '7', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('shows error for invalid selection', async () => {
      const state = makeState(listPayload);
      const result = await runListOffersFlow(state, '9', workerProfile, ctx);
      expect(result.nextState?.step).toBe(0);
    });
  });

  describe('detail step', () => {
    const detailPayload = {
      offerIds: OFFER_IDS,
      step: 'detail',
      selectedOfferIndex: 0,
    };

    it('applies to offer when input is "1"', async () => {
      const state = makeState(detailPayload);
      const result = await runListOffersFlow(state, '1', workerProfile, ctx);
      // Goes to apply-job flow
      expect(result.nextState?.flowId).not.toBe(FLOW_IDS.LIST_OFFERS);
    });

    it('shows full description when input is "2"', async () => {
      const state = makeState(detailPayload);
      const result = await runListOffersFlow(state, '2', workerProfile, ctx);
      expect(result.reply[0]).toContain('DÉTAILS COMPLETS');
    });

    it('returns to list when input is "3"', async () => {
      const state = makeState(detailPayload);
      // findById is called for each offer to rebuild the list
      const result = await runListOffersFlow(state, '3', workerProfile, ctx);
      expect(result.nextState?.payload.step).toBe('list');
    });

    it('goes to menu when input is "4"', async () => {
      const state = makeState(detailPayload);
      const result = await runListOffersFlow(state, '4', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('shows quantity in offer detail', async () => {
      const state = makeState(detailPayload);
      (mockJobOfferService.findById as jest.Mock).mockResolvedValue(makeOffer('offer-1'));
      const result = await runListOffersFlow(state, '2', workerProfile, ctx);
      expect(result.reply[0]).toContain('Personnes requises');
      expect(result.reply[0]).toContain('2');
    });
  });

  describe('menu command', () => {
    it('returns to menu when "menu" is typed', async () => {
      const state = makeState({ offerIds: OFFER_IDS, step: 'list' });
      const result = await runListOffersFlow(state, 'menu', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });
  });
});
