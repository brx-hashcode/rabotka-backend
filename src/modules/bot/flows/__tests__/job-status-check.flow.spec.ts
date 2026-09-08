import { runJobStatusCheckFlow } from '../job-status-check.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { PaymentFlow } from '@prisma/client';

// The worker answers this flow now — completion is theirs to confirm.
const profile: BotProfile = {
  id: 'worker-1',
  first_name: 'John',
  last_name: 'Worker',
  phone: '+242000001',
  email: 'worker@test.com',
  profile_type: 'WORKER',
  reliability_score: 85,
  status: 'ACTIVE',
};

function makeState(payload: any = {}): BotState {
  return {
    flowId: FLOW_IDS.JOB_STATUS_CHECK,
    step: 0,
    payload: {
      jobOfferId: 'job-1',
      jobTitle: 'Plombier',
      applicationId: 'app-1',
      paymentFlow: PaymentFlow.DAILY,
      snoozeCount: 0,
      ...payload,
    },
    updatedAt: new Date().toISOString(),
  };
}

function makeCtx() {
  return {
    applicationService: {
      markCompletedByWorker: jest.fn().mockResolvedValue({}),
    } as any,
    notificationService: {} as any,
    queueService: {
      addJob: jest.fn().mockResolvedValue(undefined),
    } as any,
  };
}

describe('runJobStatusCheckFlow', () => {
  it('returns menu when menu command sent', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(
      makeState(),
      'menu',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
  });

  it('returns menu when 3 sent', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(makeState(), '3', profile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('returns error when no jobOfferId', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(
      makeState({ jobOfferId: undefined }),
      '1',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Erreur');
  });

  it('returns error when no applicationId', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(
      makeState({ applicationId: undefined }),
      '1',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
  });

  it('confirms mission complete when 1 entered', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(makeState(), '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('terminée');
    expect(ctx.applicationService.markCompletedByWorker).toHaveBeenCalled();
  });

  it('returns error when markCompletedByWorker fails', async () => {
    const ctx = makeCtx();
    ctx.applicationService.markCompletedByWorker.mockRejectedValue(
      new Error('Failed'),
    );
    const result = await runJobStatusCheckFlow(makeState(), '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Failed');
  });

  it('snoozes when 2 entered', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(makeState(), '2', profile, ctx);
    expect(result.nextState?.payload?.snoozeCount).toBe(1);
    expect(ctx.queueService.addJob).toHaveBeenCalled();
  });

  it('snoozes with HOURLY payment flow', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(
      makeState({ paymentFlow: PaymentFlow.HOURLY }),
      '2',
      profile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
  });

  it('snoozes with MONTHLY payment flow', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(
      makeState({ paymentFlow: PaymentFlow.MONTHLY }),
      '2',
      profile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
  });

  it('shows prompt for unrecognized input', async () => {
    const ctx = makeCtx();
    const result = await runJobStatusCheckFlow(
      makeState(),
      'xyz',
      profile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
    expect(result.reply[0]).toContain('Plombier');
  });

  it('handles queueService failure gracefully', async () => {
    const ctx = makeCtx();
    ctx.queueService.addJob.mockRejectedValue(new Error('Queue error'));
    const result = await runJobStatusCheckFlow(makeState(), '2', profile, ctx);
    expect(result.nextState).toBeDefined();
  });
});
