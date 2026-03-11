import { runPublishJobFlow, getPublishJobFirstMessage, getPublishJobInitialState } from '../publish-job.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { JobOfferService } from '../../../job-offer/job-offer.service';
import { FLOW_IDS } from '../../bot.constants';
import { PaymentFlow } from '@prisma/client';

function makeState(step: number, payload: Record<string, unknown> = {}): BotState {
  return { flowId: FLOW_IDS.PUBLISH_JOB, step, payload, updatedAt: new Date().toISOString() };
}

const employerProfile: BotProfile = {
  id: 'employer-1',
  first_name: 'John',
  last_name: 'Doe',
  profile_type: 'EMPLOYER',
  status: 'ACTIVE',
  phone: '+242000000',
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

const ctx = { jobOfferService: mockJobOfferService };

beforeEach(() => jest.clearAllMocks());

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
      const result = await runPublishJobFlow(state, 'Titre test', workerProfile, ctx);
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
      const result = await runPublishJobFlow(state, 'abc', employerProfile, ctx);
      expect(result.reply[0]).toContain('titre doit contenir');
      expect(result.nextState?.step).toBe(1);
    });

    it('rejects title that is too long', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(state, 'x'.repeat(101), employerProfile, ctx);
      expect(result.reply[0]).toContain('titre doit contenir');
    });

    it('accepts valid title and advances to step 2', async () => {
      const state = makeState(1);
      const result = await runPublishJobFlow(state, 'Plombier pour urgence', employerProfile, ctx);
      expect(result.nextState?.step).toBe(2);
      expect(result.nextState?.payload.title).toBe('Plombier pour urgence');
    });
  });

  describe('Step 2 — description', () => {
    it('rejects description that is too short', async () => {
      const state = makeState(2);
      const result = await runPublishJobFlow(state, 'short', employerProfile, ctx);
      expect(result.reply[0]).toContain('description doit contenir');
      expect(result.nextState?.step).toBe(2);
    });

    it('accepts valid description and advances to step 3', async () => {
      const state = makeState(2);
      const desc = 'x'.repeat(50);
      const result = await runPublishJobFlow(state, desc, employerProfile, ctx);
      expect(result.nextState?.step).toBe(3);
    });
  });

  describe('Step 3 — date', () => {
    it('rejects invalid date format', async () => {
      const state = makeState(3);
      const result = await runPublishJobFlow(state, '2026-01-01', employerProfile, ctx);
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
      const result = await runPublishJobFlow(state, `${d}/${m}/${y} ${h}:${min}`, employerProfile, ctx);
      expect(result.reply[0]).toContain('au moins');
    });

    it('accepts valid future date and advances to step 4', async () => {
      const state = makeState(3);
      const result = await runPublishJobFlow(state, futureDate(5), employerProfile, ctx);
      expect(result.nextState?.step).toBe(4);
    });
  });

  describe('Step 4 — amount', () => {
    it('rejects amount below minimum', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(state, '500', employerProfile, ctx);
      expect(result.reply[0]).toContain('Montant invalide');
    });

    it('accepts valid amount and advances to step 5', async () => {
      const state = makeState(4);
      const result = await runPublishJobFlow(state, '15000', employerProfile, ctx);
      expect(result.nextState?.step).toBe(5);
      expect(result.nextState?.payload.amount).toBe(15000);
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

    it('accepts 2 (DAILY) and advances to step 6', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '2', employerProfile, ctx);
      expect(result.nextState?.payload.payment_flow).toBe('DAILY');
    });

    it('accepts 3 (MONTHLY) and advances to step 6', async () => {
      const state = makeState(5);
      const result = await runPublishJobFlow(state, '3', employerProfile, ctx);
      expect(result.nextState?.payload.payment_flow).toBe('MONTHLY');
    });
  });

  describe('Step 6 — address', () => {
    it('rejects address that is too short', async () => {
      const state = makeState(6);
      const result = await runPublishJobFlow(state, 'short', employerProfile, ctx);
      expect(result.reply[0]).toContain('adresse doit contenir');
    });

    it('accepts valid address and advances to step 7 (quantity)', async () => {
      const state = makeState(6);
      const result = await runPublishJobFlow(state, '123 Avenue de la Paix, Brazzaville', employerProfile, ctx);
      expect(result.nextState?.step).toBe(7);
      expect(result.reply[0]).toContain('ÉTAPE 7/8');
      expect(result.reply[0]).toContain('personnes');
    });
  });

  describe('Step 7 — quantity (new step)', () => {
    it('rejects quantity 0', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.reply[0]).toContain('Nombre invalide');
      expect(result.nextState?.step).toBe(7);
    });

    it('rejects quantity > 100', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(state, '101', employerProfile, ctx);
      expect(result.reply[0]).toContain('Nombre invalide');
    });

    it('rejects non-numeric input', async () => {
      const state = makeState(7);
      const result = await runPublishJobFlow(state, 'beaucoup', employerProfile, ctx);
      expect(result.reply[0]).toContain('Nombre invalide');
    });

    it('accepts 1 and advances to step 8', async () => {
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

  describe('Step 8 — note (formerly step 7)', () => {
    it('skips note with "Non" and shows confirmation', async () => {
      const state = makeState(8, { title: 'Test', description: 'x'.repeat(30), quantity: 1, amount: 10000, payment_flow: 'DAILY', address: '123 Avenue test', scheduled_at: new Date(Date.now() + 5 * 3600000).toISOString() });
      const result = await runPublishJobFlow(state, 'Non', employerProfile, ctx);
      expect(result.nextState?.step).toBe(9);
      expect(result.reply[0]).toContain('RÉCAPITULATIF');
    });

    it('skips note with "Passer"', async () => {
      const state = makeState(8, { title: 'Test', description: 'x'.repeat(30), quantity: 1, amount: 10000, payment_flow: 'DAILY', address: '123 Avenue test', scheduled_at: new Date(Date.now() + 5 * 3600000).toISOString() });
      const result = await runPublishJobFlow(state, 'Passer', employerProfile, ctx);
      expect(result.nextState?.step).toBe(9);
    });

    it('rejects note that is too long', async () => {
      const state = makeState(8, {});
      const result = await runPublishJobFlow(state, 'x'.repeat(501), employerProfile, ctx);
      expect(result.reply[0]).toContain('note ne peut pas dépasser');
    });

    it('shows Nombre de personnes in summary', async () => {
      const state = makeState(8, { title: 'T', description: 'x'.repeat(30), quantity: 3, amount: 10000, payment_flow: 'DAILY', address: '123 Avenue test', scheduled_at: new Date(Date.now() + 5 * 3600000).toISOString() });
      const result = await runPublishJobFlow(state, 'Non', employerProfile, ctx);
      expect(result.reply[0]).toContain('Nombre de personnes');
      expect(result.reply[0]).toContain('3');
    });
  });

  describe('Step 9 — confirmation (formerly step 8)', () => {
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
      const state = makeState(9, fullPayload);
      const result = await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('publiée avec succès');
    });

    it('cancels when user inputs "3"', async () => {
      const state = makeState(9, fullPayload);
      const result = await runPublishJobFlow(state, '3', employerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('annulée');
    });

    it('goes to step 10 (modifier) when user inputs "2"', async () => {
      const state = makeState(9, fullPayload);
      const result = await runPublishJobFlow(state, '2', employerProfile, ctx);
      expect(result.nextState?.step).toBe(10);
      expect(result.reply[0]).toContain('1-8');
    });

    it('passes quantity to jobOfferService.create', async () => {
      const state = makeState(9, fullPayload);
      await runPublishJobFlow(state, '1', employerProfile, ctx);
      expect(mockJobOfferService.create).toHaveBeenCalledWith(
        employerProfile.id,
        expect.objectContaining({ quantity: 2 }),
      );
    });
  });

  describe('Step 10 — modifier selection (formerly step 9)', () => {
    it('redirects to a valid step (1-8)', async () => {
      const state = makeState(10, { title: 'Test' });
      const result = await runPublishJobFlow(state, '3', employerProfile, ctx);
      expect(result.nextState?.step).toBe(3);
    });

    it('rejects invalid step number (9)', async () => {
      const state = makeState(10, {});
      const result = await runPublishJobFlow(state, '9', employerProfile, ctx);
      expect(result.reply[0]).toContain('Numéro invalide');
    });

    it('rejects step number 0', async () => {
      const state = makeState(10, {});
      const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
      expect(result.reply[0]).toContain('Numéro invalide');
    });
  });
});
