import { Logger } from '@nestjs/common';
import { InboundIngestService } from '../inbound-ingest.service';
import type { InboundEvent } from '../../contracts';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeRedis(
  overrides: { setResult?: string | null; count?: number } = {},
) {
  const pipeline = {
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([
      [null, overrides.count ?? 1],
      [null, 1],
    ]),
  };
  return {
    set: jest
      .fn()
      .mockResolvedValue(
        overrides.setResult === undefined ? 'OK' : overrides.setResult,
      ),
    pipeline: jest.fn().mockReturnValue(pipeline),
  };
}

function makeProvider(
  caps: { readReceipts?: boolean; typingIndicator?: boolean } = {},
) {
  return {
    name: 'cloud',
    capabilities: {
      readReceipts: caps.readReceipts ?? true,
      typingIndicator: caps.typingIndicator ?? true,
    },
    markAsRead: jest.fn().mockResolvedValue(undefined),
    sendTypingIndicator: jest.fn().mockResolvedValue(undefined),
  };
}

function makeFeedback() {
  return { handleSubmission: jest.fn().mockResolvedValue(undefined) };
}

function makeDeps(redisOverrides = {}, provider = makeProvider()) {
  const redis = makeRedis(redisOverrides);
  const queueService = { addJob: jest.fn().mockResolvedValue(undefined) };
  const sendTiming = {
    time: jest.fn(
      (_s: string, _d: string, _m: unknown, fn: () => Promise<unknown>) => fn(),
    ),
    observe: jest.fn(),
    recordDelivered: jest.fn().mockResolvedValue(undefined),
  };
  const feedback = makeFeedback();
  // Claims are granted by default. The queued path no longer claims at all —
  // that moved to the worker — so this only affects the flow_reply branch.
  const idempotency = {
    claim: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InboundIngestService(
    redis as never,
    queueService as never,
    sendTiming as never,
    provider as never,
    feedback as never,
    idempotency as never,
  );
  return {
    service,
    redis,
    queueService,
    sendTiming,
    provider,
    feedback,
    idempotency,
  };
}

const message = (
  over: Partial<Extract<InboundEvent, { kind: 'message' }>> = {},
) =>
  ({
    kind: 'message',
    from: '+242069917686',
    providerMessageId: 'wamid.1',
    timestamp: new Date(),
    provider: 'cloud',
    content: { type: 'text', text: 'Bonjour' },
    ...over,
  }) as InboundEvent;

describe('InboundIngestService', () => {
  it('enqueues a message for background processing', async () => {
    const { service, queueService } = makeDeps();
    await service.ingest([message()]);
    expect(queueService.addJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phone: '+242069917686',
        text: 'Bonjour',
        messageSid: 'wamid.1',
      }),
      expect.objectContaining({ jobId: 'wa-in-wamid.1' }),
    );
  });

  it('sets jobId to the message id so BullMQ refuses a replay outright', async () => {
    // First line of defence only: the record is dropped by removeOnComplete
    // after an hour, and the duplicate that prompted this work arrived at 38
    // minutes. The worker's claim is what covers the full retry window.
    const { service, queueService } = makeDeps();
    await service.ingest([message({ providerMessageId: 'wamid.abc' })]);
    expect(queueService.addJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { jobId: 'wa-in-wamid.abc' },
    );
  });

  it('does NOT claim for queued messages — that belongs to the worker', async () => {
    // Deliberate: claiming here would win the race every time and the worker's
    // claim, the only one that also covers BullMQ retries and stalled-job
    // re-runs, would never fire. See whatsapp-inbound.processor.spec.ts.
    const { service, idempotency, queueService } = makeDeps();
    await service.ingest([message()]);
    expect(idempotency.claim).not.toHaveBeenCalled();
    expect(queueService.addJob).toHaveBeenCalled();
  });

  it('drops a message once the per-phone rate limit is exceeded', async () => {
    const { service, queueService } = makeDeps({ count: 31 });
    await service.ingest([message()]);
    expect(queueService.addJob).not.toHaveBeenCalled();
  });

  it('records delivery latency from a normalized status, whatever the provider', async () => {
    const { service, sendTiming } = makeDeps();
    await service.ingest([
      {
        kind: 'status',
        providerMessageId: 'wamid.9',
        status: 'delivered',
        timestamp: new Date(),
        provider: 'cloud',
      },
    ]);
    expect(sendTiming.recordDelivered).toHaveBeenCalledWith('wamid.9');
  });

  it('does not enqueue anything for a status event', async () => {
    const { service, queueService } = makeDeps();
    await service.ingest([
      {
        kind: 'status',
        providerMessageId: 'x',
        status: 'sent',
        timestamp: new Date(),
        provider: 'cloud',
      },
    ]);
    expect(queueService.addJob).not.toHaveBeenCalled();
  });

  it('processes every event in a batch', async () => {
    const { service, queueService } = makeDeps();
    await service.ingest([
      message({ providerMessageId: 'm1', from: '+242001' }),
      message({ providerMessageId: 'm2', from: '+242002' }),
    ]);
    expect(queueService.addJob).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one event fails, and never throws', async () => {
    // A provider retries on any non-2xx; Meta retries hard enough that a
    // persistent 500 costs the subscription. One bad event must not take the
    // rest of the batch — or the response — down with it.
    const { service, queueService } = makeDeps();
    queueService.addJob
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);
    await expect(
      service.ingest([
        message({ providerMessageId: 'm1', from: '+242001' }),
        message({ providerMessageId: 'm2', from: '+242002' }),
      ]),
    ).resolves.toBeUndefined();
    expect(queueService.addJob).toHaveBeenCalledTimes(2);
  });

  describe('acknowledging the reader', () => {
    it('marks read and shows typing on an inbound message', async () => {
      const { service, provider } = makeDeps();
      await service.ingest([message()]);
      expect(provider.markAsRead).toHaveBeenCalledWith('wamid.1');
      expect(provider.sendTypingIndicator).toHaveBeenCalledWith('wamid.1');
    });

    it('acknowledges a replay too, now that dedup lives in the worker', async () => {
      // Behaviour change, recorded rather than hidden. The claim moved to the
      // worker, so this layer can no longer tell a replay from a first
      // delivery and will re-send ticks on both.
      //
      // Accepted: marking an already-read message read is a no-op at Meta, and
      // the cost is two API calls per replay. The alternative — claiming here
      // to detect it — is what would break the worker's claim.
      const { service, provider } = makeDeps();
      await service.ingest([message()]);
      await service.ingest([message()]);
      expect(provider.markAsRead).toHaveBeenCalledTimes(2);
    });

    it('does not acknowledge past the rate limit', async () => {
      const { service, provider } = makeDeps({ count: 31 });
      await service.ingest([message()]);
      expect(provider.markAsRead).not.toHaveBeenCalled();
    });

    it('skips what the provider cannot do', async () => {
      // Twilio has neither. The calls no-op there anyway, but asking first
      // keeps the intent visible rather than relying on that.
      const { service, provider } = makeDeps(
        {},
        makeProvider({ readReceipts: false, typingIndicator: false }),
      );
      await service.ingest([message()]);
      expect(provider.markAsRead).not.toHaveBeenCalled();
      expect(provider.sendTypingIndicator).not.toHaveBeenCalled();
    });

    it('still delivers the message when acknowledging fails', async () => {
      // A courtesy must never cost the reader the reply it was announcing.
      const provider = makeProvider();
      provider.markAsRead.mockRejectedValue(new Error('stale wamid'));
      const { service, queueService } = makeDeps({}, provider);
      await expect(service.ingest([message()])).resolves.toBeUndefined();
      expect(queueService.addJob).toHaveBeenCalledTimes(1);
    });

    it('does not acknowledge a status event', async () => {
      const { service, provider } = makeDeps();
      await service.ingest([
        {
          kind: 'status',
          providerMessageId: 'wamid.9',
          status: 'delivered',
          timestamp: new Date(),
          provider: 'cloud',
        },
      ]);
      expect(provider.markAsRead).not.toHaveBeenCalled();
    });
  });

  describe('a submitted Flow', () => {
    const flowEvent = () =>
      ({
        kind: 'message',
        from: '+242069917686',
        providerMessageId: 'wamid.flow',
        timestamp: new Date(),
        provider: 'cloud',
        content: {
          type: 'flow_reply',
          flowToken: 'fb_profile-1_abc',
          answers: { score: '5', comment: 'Super' },
        },
      }) as InboundEvent;

    it('goes to the feedback service, not the bot queue', async () => {
      // A form submission has no text for the bot to answer, and replying to
      // it would be noise.
      const { service, queueService, feedback } = makeDeps();
      await service.ingest([flowEvent()]);
      expect(feedback.handleSubmission).toHaveBeenCalledTimes(1);
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it('is de-duplicated here, because it never reaches the worker', async () => {
      // A submitted Flow is handled inline, so the worker's claim cannot cover
      // it — this branch keeps its own. Meta retries the webhook and a
      // resubmitted form must not double-count.
      const { service, feedback, idempotency } = makeDeps();
      idempotency.claim.mockResolvedValue(false);
      await service.ingest([flowEvent()]);
      expect(feedback.handleSubmission).not.toHaveBeenCalled();
    });

    it('claims the flow reply under the shared inbound namespace', async () => {
      // One namespace for Twilio SIDs and Cloud wamids: they cannot collide,
      // and a message stays de-duplicated across a provider flip.
      const { service, idempotency } = makeDeps();
      await service.ingest([flowEvent()]);
      expect(idempotency.claim).toHaveBeenCalledWith(
        expect.stringContaining('wa:in:'),
        604800,
      );
    });
  });

  it('routes an interactive reply to the bot as its id', async () => {
    const { service, queueService } = makeDeps();
    await service.ingest([
      message({ content: { type: 'interactive_reply', replyId: '2' } }),
    ]);
    expect(queueService.addJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: '2' }),
      expect.anything(),
    );
  });
});
