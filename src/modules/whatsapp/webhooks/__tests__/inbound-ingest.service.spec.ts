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

function makeDeps(redisOverrides = {}) {
  const redis = makeRedis(redisOverrides);
  const queueService = { addJob: jest.fn().mockResolvedValue(undefined) };
  const sendTiming = {
    time: jest.fn(
      (_s: string, _d: string, _m: unknown, fn: () => Promise<unknown>) => fn(),
    ),
    observe: jest.fn(),
    recordDelivered: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InboundIngestService(
    redis as never,
    queueService as never,
    sendTiming as never,
  );
  return { service, redis, queueService, sendTiming };
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
