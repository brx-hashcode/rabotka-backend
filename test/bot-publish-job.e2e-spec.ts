jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

import {
  runPublishJobFlow,
  getPublishJobInitialState,
  getPublishJobFirstMessage,
} from '../src/modules/bot/flows/publish-job.flow';
import type {
  BotProfile,
  BotState,
} from '../src/modules/bot/types/bot-state.types';
import type { JobOfferService } from '../src/modules/job-offer/job-offer.service';
import { PaymentFlow } from '@prisma/client';

const employerProfile: BotProfile = {
  id: 'employer-e2e-1',
  first_name: 'John',
  last_name: 'Doe',
  profile_type: 'EMPLOYER',
  status: 'ACTIVE',
  phone: '+242000000',
  email: 'john.e2e@example.com',
  reliability_score: 100,
};

const workerProfile: BotProfile = {
  ...employerProfile,
  id: 'worker-e2e-1',
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

const mockCreateOffer = jest.fn();
const mockJobOfferService = {
  create: mockCreateOffer,
} as unknown as jest.Mocked<JobOfferService>;
const ctx = { jobOfferService: mockJobOfferService };

beforeEach(() => jest.clearAllMocks());

/** Helper to run through flow steps sequentially */
async function runSteps(
  profile: BotProfile,
  steps: string[],
): Promise<{ state: BotState; replies: string[][] }> {
  let state: BotState = getPublishJobInitialState();
  const replies: string[][] = [];

  for (const input of steps) {
    const result = await runPublishJobFlow(state, input, profile, ctx);
    replies.push(result.reply);
    if (result.clearState) {
      break;
    }
    if (result.nextState) {
      state = result.nextState;
    }
  }

  return { state, replies };
}

describe('Bot publish-job flow (e2e)', () => {
  it('non-employer trying to publish → receives error message immediately', async () => {
    const state = getPublishJobInitialState();
    const result = await runPublishJobFlow(
      state,
      'Test title',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Seuls les employeurs');
  });

  it('employer completes all 8 steps with quantity → offer created', async () => {
    mockCreateOffer.mockResolvedValue({ id: 'offer-new-1', quantity: 3 });

    const { replies } = await runSteps(employerProfile, [
      'Plombier pour réparation urgente', // Step 1: title
      'Réparation fuite eau cuisine, remplacement robinet, vérification tuyauterie complet.', // Step 2: description
      futureDate(5), // Step 3: date
      '15000', // Step 4: amount
      '2', // Step 5: DAILY payment flow
      '123 Avenue de la Paix, Poto-Poto, Brazzaville', // Step 6: address
      '3', // Step 7: quantity = 3
      'Non', // Step 8: no note
      '1', // Step 9: confirm publish
    ]);

    expect(mockCreateOffer).toHaveBeenCalledWith(
      employerProfile.id,
      expect.objectContaining({
        title: 'Plombier pour réparation urgente',
        quantity: 3,
        payment_flow: PaymentFlow.DAILY,
      }),
    );

    const lastReply = replies.at(-1) ?? [];
    expect(lastReply[0]).toContain('publiée avec succès');
  });

  it('employer modifies a step mid-flow (step 9 → modifier → step 3 → continue)', async () => {
    mockCreateOffer.mockResolvedValue({ id: 'offer-modified-1', quantity: 1 });

    // Go through steps up to confirmation
    const { state } = await runSteps(employerProfile, [
      'Plombier pour urgence',
      'Description longue pour test flow modifier flow complete.',
      futureDate(5),
      '20000',
      '1',
      '123 Avenue de la Paix, Brazzaville, Congo',
      '1',
      'Non',
      // At step 9, choose to modify
    ]);

    // At step 9, choose "2" (Modifier)
    const modifyResult = await runPublishJobFlow(
      state,
      '2',
      employerProfile,
      ctx,
    );
    expect(modifyResult.nextState?.step).toBe(10);
    expect(modifyResult.reply[0]).toContain('1-8');

    const nextState = modifyResult.nextState;
    expect(nextState).toBeDefined();
    if (!nextState) return;

    // At step 10, choose to go back to step 3 (date)
    const selectStepResult = await runPublishJobFlow(
      nextState,
      '3',
      employerProfile,
      ctx,
    );
    expect(selectStepResult.nextState?.step).toBe(3);
  });

  it('employer cancels mid-flow at step 9', async () => {
    const { state } = await runSteps(employerProfile, [
      'Plombier pour urgence',
      'Description longue pour test annulation complet flow.',
      futureDate(5),
      '12000',
      '3',
      '456 Boulevard Marien Ngouabi, Brazzaville',
      '2',
      'Apporter vos propres outils',
      // At step 9, cancel
    ]);

    const cancelResult = await runPublishJobFlow(
      state,
      '3',
      employerProfile,
      ctx,
    );
    expect(cancelResult.clearState).toBe(true);
    expect(cancelResult.reply[0]).toContain('annulée');
    expect(mockCreateOffer).not.toHaveBeenCalled();
  });

  it('quantity step validates: 0 is invalid', async () => {
    const { state } = await runSteps(employerProfile, [
      'Plombier pour urgence',
      'Description longue pour test validation quantité zero.',
      futureDate(5),
      '15000',
      '2',
      '123 Avenue de la Paix, Brazzaville, Congo',
      // At step 7
    ]);
    expect(state.step).toBe(7);
    const result = await runPublishJobFlow(state, '0', employerProfile, ctx);
    expect(result.nextState?.step).toBe(7);
    expect(result.reply[0]).toContain('Nombre invalide');
  });

  it('first message contains ÉTAPE 1/8', () => {
    const msg = getPublishJobFirstMessage();
    expect(msg).toContain('ÉTAPE 1/8');
  });
});
