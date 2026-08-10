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
  const service = new InboundIngestService(
    redis as never,
    queueService as never,
    sendTiming as never,
    provider as never,
    feedback as never,
  );
  return { service, redis, queueService, sendTiming, provider, feedback };
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
    );
  });

  it('de-duplicates a repeated provider message id', async () => {
    const { service, queueService } = makeDeps({ setResult: null });
    await service.ingest([message()]);
    expect(queueService.addJob).not.toHaveBeenCalled();
  });

  it('shares the dedup namespace across providers', async () => {
    // Twilio SIDs and Cloud wamids cannot collide, and a shared namespace means
    // a message stays de-duplicated across a provider flip.
    const { service, redis } = makeDeps();
    await service.ingest([
      message({ providerMessageId: 'SM1', provider: 'twilio' }),
    ]);
    await service.ingest([message({ providerMessageId: 'wamid.1' })]);
    const keys = redis.set.mock.calls.map((c) => String(c[0]));
    expect(keys[0]).toContain('wa:msg:SM1');
    expect(keys[1]).toContain('wa:msg:wamid.1');
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

    it('does not acknowledge a duplicate', async () => {
      // The reader already saw the ticks the first time; re-acknowledging is a
      // wasted call on every provider retry.
      const { service, provider } = makeDeps({ setResult: null });
      await service.ingest([message()]);
      expect(provider.markAsRead).not.toHaveBeenCalled();
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

    it('is de-duplicated like any other inbound message', async () => {
      // Meta retries the webhook; a resubmitted form must not double-count.
      const { service, feedback } = makeDeps({ setResult: null });
      await service.ingest([flowEvent()]);
      expect(feedback.handleSubmission).not.toHaveBeenCalled();
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
    );
  });
});
