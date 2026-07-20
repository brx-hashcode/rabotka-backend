import { runRepublishExpiredJobFlow } from '../republish-expired-job.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { employerMenuMessage } from '../../messages/menu.messages';

const profile: BotProfile = {
  id: 'employer-1',
  first_name: 'John',
  last_name: 'Employer',
  phone: '+242000001',
  email: 'employer@test.com',
  profile_type: 'EMPLOYER',
  reliability_score: 85,
  status: 'ACTIVE',
};

const mockJob = {
  id: 'job-1',
  title: 'Plombier',
  description: 'Description',
  address: 'Brazzaville',
  amount: 15000,
  payment_flow: 'DAILY',
  quantity: 1,
  note: null,
  employer_id: 'employer-1',
};

function makeState(step = 0, payload: any = { jobOfferId: 'job-1' }): BotState {
  return {
    flowId: FLOW_IDS.REPUBLISH_EXPIRED_JOB,
    step,
    payload,
    updatedAt: new Date().toISOString(),
  };
}

function makeCtx(jobOverrides: any = {}) {
  return {
    prisma: {
      jobOffer: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            jobOverrides === null ? null : { ...mockJob, ...jobOverrides },
          ),
        update: jest.fn().mockResolvedValue({ id: 'job-1' }),
      },
    } as any,
  };
}

describe('runRepublishExpiredJobFlow', () => {
  describe('step 0', () => {
    it('returns menu when menu command sent', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        'menu',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('returns rendered menu when 2 sent', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        '2',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toBe(employerMenuMessage());
      expect(result.reply[0]).not.toContain('Tapez');
    });

    it('shows republish prompt for unknown input', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        'xyz',
        profile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('expirée');
    });

    it('fetches job and moves to step 1 when 1 entered', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        '1',
        profile,
        ctx,
      );
      expect(result.nextState?.step).toBe(1);
    });

    it('returns menu when no jobOfferId in state', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        makeState(0, {}),
        '1',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('returns error when job not found', async () => {
      const ctx = makeCtx(null);
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        '1',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('introuvable');
    });

    it('returns error when job belongs to different employer', async () => {
      const ctx = makeCtx({ employer_id: 'other-employer' });
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        '1',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('handles republier command', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        makeState(0),
        'republier',
        profile,
        ctx,
      );
      expect(result.nextState?.step).toBe(1);
    });
  });

  describe('step 1', () => {
    const step1State = makeState(1, {
      jobOfferId: 'job-1',
      title: 'Plombier',
      description: 'Description',
      address: 'Brazzaville',
      amount: 15000,
      payment_flow: 'DAILY',
      quantity: 1,
      note: '',
    });

    it('returns menu when menu command sent', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        step1State,
        'menu',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('returns format error for invalid date', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        step1State,
        'invalid date',
        profile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('Format invalide');
    });

    it('returns error for date in the past', async () => {
      const ctx = makeCtx();
      const result = await runRepublishExpiredJobFlow(
        step1State,
        '01/01/2020 09:00',
        profile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
    });

    it('republishes job successfully with valid future date', async () => {
      const ctx = makeCtx();
      const futureDate = new Date(Date.now() + 86400000 * 7);
      const dd = String(futureDate.getDate()).padStart(2, '0');
      const mm = String(futureDate.getMonth() + 1).padStart(2, '0');
      const yyyy = futureDate.getFullYear();
      const dateStr = `${dd}/${mm}/${yyyy} 09:00`;

      const result = await runRepublishExpiredJobFlow(
        step1State,
        dateStr,
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('republiée');
    });

    it('returns error when job update fails', async () => {
      const ctx = makeCtx();
      ctx.prisma.jobOffer.update.mockRejectedValue(new Error('Update failed'));
      const futureDate = new Date(Date.now() + 86400000 * 7);
      const dd = String(futureDate.getDate()).padStart(2, '0');
      const mm = String(futureDate.getMonth() + 1).padStart(2, '0');
      const yyyy = futureDate.getFullYear();
      const dateStr = `${dd}/${mm}/${yyyy} 09:00`;

      const result = await runRepublishExpiredJobFlow(
        step1State,
        dateStr,
        profile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('Update failed');
    });
  });

  describe('unknown step', () => {
    it('returns menu for unknown step', async () => {
      const ctx = makeCtx();
      const state = makeState(99);
      const result = await runRepublishExpiredJobFlow(
        state,
        'test',
        profile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });
  });
});
