import {
  runPublishJobFlow,
  getPublishJobFirstMessage,
  getPublishJobInitialState,
  getPublishJobResumeState,
  getPublishJobDraftResumeMessage,
} from '../publish-job.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { JobOfferService } from '../../../job-offer/job-offer.service';
import { FLOW_IDS } from '../../bot.constants';

function makeState(
  step: number,
  payload: Record<string, unknown> = {},
): BotState {
  return {
    flowId: FLOW_IDS.PUBLISH_JOB,
    step,
    payload,
    updatedAt: new Date().toISOString(),
  };
}

const employerProfile: BotProfile = {
  id: 'employer-1',
  first_name: 'John',
  last_name: 'Doe',
  profile_type: 'EMPLOYER',
  status: 'ACTIVE',
  phone: '+242000000',
  email: 'john@example.com',
  reliability_score: 100,
};

const workerProfile: BotProfile = {
  ...employerProfile,
  id: 'worker-1',
  profile_type: 'WORKER',
};

function futureDate(hoursFromNow = 5): string {
  const d = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

const mockJobOfferService = {
  create: jest.fn(),
} as unknown as jest.Mocked<JobOfferService>;

const mockPaymentService = {
  generateJobPostingPaymentLink: jest
    .fn()
    .mockResolvedValue('https://pay.link/test'),
};

const mockPrisma = {
  jobCategory: {
    findMany: jest.fn().mockResolvedValue([
      { id: 'cat-1', name: 'Plomberie' },
      { id: 'cat-2', name: 'Électricité' },
    ]),
  },
};

const ctx = {
  jobOfferService: mockJobOfferService,
  paymentService: mockPaymentService as any,
  prisma: mockPrisma as any,
};

beforeEach(() => jest.clearAllMocks());

// Flow has 8 user-facing steps (title, desc, date, amount, paymentFlow,
// address, qty, note) + step 10 confirmation + step 11 modifier-picker.

describe('getPublishJobFirstMessage()', () => {
  it('returns ÉTAPE 1/8 message', () => {
    const msg = getPublishJobFirstMessage();
    expect(msg).toContain('ÉTAPE 1/8');
  });
});

describe('runPublishJobFlow()', () => {
  describe('non-employer', () => {
    it('returns error and clears state', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(
        state,
        'Titre test',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('Seuls les employeurs');
    });
  });

  describe('Step 1 — title', () => {
    it('shows prompt when no input', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(state, '', employerProfile, ctx);
      expect(result.reply[0]).toContain('ÉTAPE 1/8');
      expect(result.nextState?.step).toBe(1);
    });

    it('rejects title that is too short', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(
        state,
        'abc',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('titre doit contenir');
      expect(result.nextState?.step).toBe(1);
    });

    it('rejects title that is too long', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(
        state,
        'x'.repeat(101),
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('titre doit contenir');
    });

    it('accepts valid title and advances to step 2 (description)', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(
        state,
        'Plombier pour urgence',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(2);
      expect(result.nextState?.payload.title).toBe('Plombier pour urgence');
    });
  });

  describe('Step 2 — description', () => {
    it('rejects description that is too short', async () => {
      const state = makeState(2, { title: 'Plombier' });
      const result = await runPublishJobFlow(
        state,
        'short',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('description doit contenir');
      expect(result.nextState?.step).toBe(2);
    });

    it('rejects description too long', async () => {
      const state = makeState(2, { title: 'Plombier' });
      const result = await runPublishJobFlow(
        state,
        'x'.repeat(1001),
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('description doit contenir');
    });

    it('accepts valid description and advances to step 3 (date)', async () => {
      const state = makeState(2, { title: 'Plombier' });
      const desc = 'x'.repeat(50);
      const result = await runPublishJobFlow(state, desc, employerProfile, ctx);
      expect(result.nextState?.step).toBe(3);
    });
  });

  describe('Step 3 — date', () => {
    it('rejects invalid date format', async () => {
      const state = makeState(3);
      const result = await runPublishJobFlow(
        state,
        '2026-01-01',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Format invalide');
    });

    it('rejects date < 4h from now', async () => {
      const state = makeState(3);
      const pastDate = new Date(Date.now() + 1 * 60 * 60 * 1000);
      const d = String(pastDate.getDate()).padStart(2, '0');
      const m = String(pastDate.getMonth() + 1).padStart(2, '0');
      const y = pastDate.getFullYear();
      const h = String(pastDate.getHours()).padStart(2, '0');
      const min = String(pastDate.getMinutes()).padStart(2, '0');
      const result = await runPublishJobFlow(
        state,
        `${d}/${m}/${y} ${h}:${min}`,
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('au moins');
    });

    it('accepts valid future date and advances to step 4 (amount)', async () => {
      const state = makeState(3);
      const result = await runPublishJobFlow(
        state,
        futureDate(5),
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(4);
    });
  });

  describe('Step 4 — amount', () => {
    it('rejects amount below minimum', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(
        state,
        '500',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Montant invalide');
    });

    it('rejects amount above maximum', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(
        state,
        '2000000',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Montant invalide');
    });

    it('rejects NaN amount', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(
        state,
        'abc',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Montant invalide');
    });

    it('accepts valid amount and advances to step 5 (payment flow)', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(
        state,
        '15000',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(5);
      expect(result.nextState?.payload.amount).toBe(15000);
    });

    it('rejects 0 as below minimum and stays at step 4', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.nextState?.step).toBe(4);
      expect(result.reply[0]).toContain('Montant invalide');
    });
  });

  describe('Step 5 — payment flow', () => {
    it('rejects invalid choice', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '9', employerProfile, ctx);
      expect(result.reply[0]).toContain('Choix invalide');
    });

    it('accepts 1 (HOURLY) and advances to step 6', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(result.nextState?.step).toBe(6);
      expect(result.nextState?.payload.payment_flow).toBe('HOURLY');
    });

    it('accepts 2 (DAILY)', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '2', employerProfile, ctx);
      expect(result.nextState?.payload.payment_flow).toBe('DAILY');
    });

    it('accepts 3 (MONTHLY)', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '3', employerProfile, ctx);
      expect(result.nextState?.payload.payment_flow).toBe('MONTHLY');
    });

    it('accepts 0 to skip payment flow and advances to step 6', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.nextState?.step).toBe(6);
      expect(result.nextState?.payload.payment_flow).toBeNull();
    });
  });

  describe('Step 6 — address', () => {
    it('rejects address that is too short', async () => {
      const state = makeState(6);
      const result = await runPublishJobFlow(
        state,
        'short',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('adresse doit contenir');
    });

    it('accepts valid address and advances to step 7 (quantity)', async () => {
      const state = makeState(6);
      const result = await runPublishJobFlow(
        state,
        '123 Avenue de la Paix, Brazzaville',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(7);
    });
  });

  describe('Step 7 — quantity', () => {
    it('rejects quantity 0', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.reply[0]).toContain('Nombre invalide');
      expect(result.nextState?.step).toBe(7);
    });

    it('rejects quantity > 100', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(
        state,
        '101',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Nombre invalide');
    });

    it('rejects non-numeric input', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(
        state,
        'beaucoup',
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Nombre invalide');
    });

    it('accepts 1 and advances to step 8 (note)', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(result.nextState?.step).toBe(8);
      expect(result.nextState?.payload.quantity).toBe(1);
    });

    it('accepts 2 and advances to step 8', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(state, '2', employerProfile, ctx);
      expect(result.nextState?.step).toBe(8);
      expect(result.nextState?.payload.quantity).toBe(2);
    });
  });

  describe('Step 8 — note', () => {
    const fullPayload = {
      title: 'Test',
      description: 'x'.repeat(30),
      quantity: 1,
      amount: 10000,
      payment_flow: 'DAILY',
      address: '123 Avenue test',
      scheduled_at: new Date(Date.now() + 5 * 3600000).toISOString(),
    };

    it('saves note text and advances to step 10 (confirmation)', async () => {
      const state = makeState(8, fullPayload);
      const result = await runPublishJobFlow(
        state,
        'Apporter vos outils',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(10);
      expect(result.nextState?.payload.note).toBe('Apporter vos outils');
    });

    it('skips note with "0"', async () => {
      const state = makeState(8, fullPayload);
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.nextState?.step).toBe(10);
    });

    it('rejects note that is too long', async () => {
      const state = makeState(8, fullPayload);
      const result = await runPublishJobFlow(
        state,
        'x'.repeat(501),
        employerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('note ne peut pas dépasser');
    });

    it('shows Nombre de personnes in summary', async () => {
      const state = makeState(8, { ...fullPayload, quantity: 3 });
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.reply[0]).toContain('Nombre de personnes');
      expect(result.reply[0]).toContain('3');
    });
  });

  describe('Step 10 — confirmation', () => {
    const fullPayload = {
      title: 'Plombier',
      description: 'x'.repeat(30),
      scheduled_at: new Date(Date.now() + 5 * 3600000).toISOString(),
      amount: 15000,
      payment_flow: 'DAILY',
      address: '123 Avenue de la Paix, Brazzaville',
      quantity: 2,
      note: '',
    };

    beforeEach(() => {
      (mockJobOfferService.create as jest.Mock).mockResolvedValue({
        id: 'offer-uuid-1',
        quantity: 2,
      });
    });

    it('publishes offer when user inputs "1"', async () => {
      const state = makeState(10, fullPayload);
      const result = await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('publiée');
    });

    it('cancels when user inputs "3"', async () => {
      const state = makeState(10, fullPayload);
      const result = await runPublishJobFlow(state, '3', employerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('annulée');
    });

    it('goes to step 11 (modifier) when user inputs "2"', async () => {
      const state = makeState(10, fullPayload);
      const result = await runPublishJobFlow(state, '2', employerProfile, ctx);
      expect(result.nextState?.step).toBe(11);
      expect(result.reply[0]).toContain('1-8');
    });

    it('passes quantity to jobOfferService.create', async () => {
      const state = makeState(10, fullPayload);
      await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(mockJobOfferService.create).toHaveBeenCalledWith(
        employerProfile.id,
        expect.objectContaining({ quantity: 2 }),
      );
    });
  });

  describe('Step 11 — modifier selection', () => {
    it('redirects to a valid step (1-8)', async () => {
      const state = makeState(11, { title: 'Test' });
      const result = await runPublishJobFlow(state, '3', employerProfile, ctx);
      expect(result.nextState?.step).toBe(3);
    });

    it('rejects step number > 8', async () => {
      const state = makeState(11, {});
      const result = await runPublishJobFlow(state, '9', employerProfile, ctx);
      expect(result.reply[0]).toContain('Numéro invalide');
    });

    it('rejects step number 0', async () => {
      const state = makeState(11, {});
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.reply[0]).toContain('Numéro invalide');
    });
  });

  describe('Global exit keywords', () => {
    it('exits on "exit"', async () => {
      const state = makeState(3, { title: 'test' });
      const result = await runPublishJobFlow(
        state,
        'exit',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('annulée');
    });

    it('exits on "annuler" mid-flow (non-step-10)', async () => {
      const state = makeState(3, { title: 'test' });
      const result = await runPublishJobFlow(
        state,
        'annuler',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('exits on "quitter"', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(
        state,
        'quitter',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('exits on "cancel"', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(
        state,
        'cancel',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });
  });

  describe('Step 0 — draft resume', () => {
    it('resumes draft when user inputs "1"', async () => {
      const state = makeState(0, { _draftStep: 3, title: 'My Draft' });
      const result = await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(result.nextState?.step).toBe(3);
      expect(result.reply[0]).toContain('brouillon');
    });

    it('restarts fresh when user inputs "2"', async () => {
      const state = makeState(0, { _draftStep: 5, title: 'Old' });
      const result = await runPublishJobFlow(state, '2', employerProfile, ctx);
      expect(result.nextState?.step).toBe(1);
      expect(result.clearDraft).toBe(true);
    });

    it('restarts fresh when user inputs anything else', async () => {
      const state = makeState(0, { _draftStep: 2 });
      const result = await runPublishJobFlow(
        state,
        'xyz',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(1);
    });
  });

  describe('Unknown step — fallback', () => {
    it('returns error for unknown step', async () => {
      const state = makeState(99);
      const result = await runPublishJobFlow(
        state,
        'anything',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain("Erreur d'étape");
    });
  });

  describe('Exported helpers', () => {
    it('getPublishJobInitialState() returns step 1', () => {
      const s = getPublishJobInitialState();
      expect(s.step).toBe(1);
    });

    it('getPublishJobResumeState() returns state with given step', () => {
      const s = getPublishJobResumeState(5, { title: 'X' });
      expect(s.step).toBe(5);
      expect(s.payload.title).toBe('X');
    });

    it('getPublishJobDraftResumeMessage() with title', () => {
      const msg = getPublishJobDraftResumeMessage(4, { title: 'My Job' });
      expect(msg).toContain('My Job');
      expect(msg).toContain('Reprendre');
    });

    it('getPublishJobDraftResumeMessage() without title', () => {
      const msg = getPublishJobDraftResumeMessage(4, {});
      expect(msg).toContain('Reprendre');
    });
  });
});
