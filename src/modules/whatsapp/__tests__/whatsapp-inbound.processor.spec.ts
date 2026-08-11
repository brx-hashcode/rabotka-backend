import { Logger } from '@nestjs/common';
import { WhatsAppInboundProcessor } from '../whatsapp-inbound.processor';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const mockConversationService = {
  handleIncomingMessage: jest.fn(),
};

const mockQueueService = {
  createWorker: jest.fn().mockReturnValue({}),
  addJob: jest.fn().mockResolvedValue(undefined),
};

const mockSendTiming = {
  time: jest.fn(
    (
      _stage: string,
      _dir: string,
      _meta: unknown,
      fn: () => Promise<unknown>,
    ) => fn(),
  ),
};

const redisStore = new Set<string>();
const mockIdempotency = {
  claim: jest.fn((key: string) => {
    if (redisStore.has(key)) return Promise.resolve(false);
    redisStore.add(key);
    return Promise.resolve(true);
  }),
  has: jest.fn((key: string) => Promise.resolve(redisStore.has(key))),
  release: jest.fn((key: string) => {
    redisStore.delete(key);
    return Promise.resolve();
  }),
};

const DONE = (id: string) => expect.stringContaining(`wa:in:done:${id}`);

function makeProcessor() {
  return new WhatsAppInboundProcessor(
    mockConversationService as any,
    mockQueueService as any,
    mockSendTiming as any,
    mockIdempotency as any,
  );
}

describe('WhatsAppInboundProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisStore.clear();
  });

  describe('onApplicationBootstrap()', () => {
    it('registers a worker on the inbound queue', () => {
      const processor = makeProcessor();
      processor.onApplicationBootstrap();
      expect(mockQueueService.createWorker).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.any(Function),
        expect.objectContaining({ concurrency: 5 }),
      );
    });
  });

  describe('process()', () => {
    it('enqueues a text outbound job for a plain text reply', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Bonjour !'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'Hello' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.objectContaining({
          type: 'text',
          phone: '+242001',
          text: 'Bonjour !',
        }),
      );
    });

    it('enqueues a media outbound job for an [IMG:url] reply with caption', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['[IMG:https://cdn.example.com/img.jpg]\nVoici la photo'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'photo' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.objectContaining({
          type: 'media',
          phone: '+242001',
          mediaUrl: 'https://cdn.example.com/img.jpg',
          caption: 'Voici la photo',
        }),
      );
    });

    it('enqueues a media outbound job without caption when none provided', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['[IMG:https://cdn.example.com/img.jpg]'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'photo' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.objectContaining({ type: 'media', caption: undefined }),
      );
    });

    it('enqueues a template outbound job for a [TPL:key]{vars} reply', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: [
          '[TPL:viewWorkerPortfolio]{"1":"https://img/1.png","2":"*Card*"}',
        ],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'menu' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.objectContaining({
          type: 'template',
          phone: '+242001',
          templateKey: 'viewWorkerPortfolio',
          contentVariables: { '1': 'https://img/1.png', '2': '*Card*' },
        }),
      );
    });

    it('skips a [TPL:] reply with invalid JSON variables', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['[TPL:viewWorkerPortfolio]{not-json}'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'menu' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });

    it('skips null/empty replies', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: [null, '', 'Valid reply'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'hi' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).toHaveBeenCalledTimes(1);
      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: 'Valid reply' }),
      );
    });

    it('skips [IMG:] with empty mediaUrl', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['[IMG:]caption'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'hi' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });

    it('passes profileId as undefined when null', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Hello'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'hi' }, attemptsMade: 0 });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ profileId: undefined }),
      );
    });

    it('bundles multiple replies into one ordered sequence job', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['First', 'Second'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'hi' }, attemptsMade: 0 });

      // One job, not two — so the outbound worker (concurrency 3) can't race
      // them out of order.
      expect(mockQueueService.addJob).toHaveBeenCalledTimes(1);
      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'sequence',
          phone: '+242001',
          profileId: 'p-1',
          messages: [
            { type: 'text', text: 'First' },
            { type: 'text', text: 'Second' },
          ],
        }),
      );
    });
  });

  describe('idempotency', () => {
    it('handles a message whose id it has not seen', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Bonjour !'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({
        data: { phone: '+242001', text: 'Hello', messageSid: 'wamid.1' },
        attemptsMade: 0,
      });

      // The marker is written AFTER handling, with Meta's full retry window.
      expect(mockConversationService.handleIncomingMessage).toHaveBeenCalled();
      expect(mockIdempotency.claim).toHaveBeenCalledWith(DONE('wamid.1'), 604800);
    });

    it('drops a message whose id is already claimed, without sending', async () => {
      // Already handled: the done marker is present.
      redisStore.add(`rabotka:dev:wa:in:done:wamid.1`);

      const processor = makeProcessor();
      await processor.process({
        data: { phone: '+242001', text: 'Hello', messageSid: 'wamid.1' },
        attemptsMade: 0,
      });

      expect(
        mockConversationService.handleIncomingMessage,
      ).not.toHaveBeenCalled();
      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });

    it('returns rather than throws on a duplicate', async () => {
      // A throw would be retried by BullMQ, which is the behaviour being
      // suppressed — the retry would find the claim taken and throw again,
      // burning all three attempts before landing in the DLQ.
      redisStore.add(`rabotka:dev:wa:in:done:wamid.1`);

      const processor = makeProcessor();
      await expect(
        processor.process({
          data: { phone: '+242001', text: 'Hello', messageSid: 'wamid.1' },
          attemptsMade: 0,
        }),
      ).resolves.toBeUndefined();
    });

    it('catches a BullMQ retry of a job that already succeeded', async () => {
      // A first attempt handled the message; BullMQ re-runs the job anyway
      // (a stalled-job re-run, or a throw somewhere after the reply). Only a
      // marker at this level sees that the work is already done.
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Bonjour !'],
        profileId: 'p-1',
      });
      const processor = makeProcessor();
      const job = {
        data: { phone: '+242001', text: 'Hello', messageSid: 'wamid.retry' },
        attemptsMade: 0,
      };

      await processor.process(job);
      expect(mockQueueService.addJob).toHaveBeenCalledTimes(1);

      await processor.process({ ...job, attemptsMade: 1 });

      expect(mockQueueService.addJob).toHaveBeenCalledTimes(1);
    });

    it('handles a message with no id rather than dropping it', async () => {
      // Nothing to de-duplicate on. Handling it risks a duplicate; dropping it
      // guarantees a lost message, so it is handled.
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Bonjour !'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({
        data: { phone: '+242001', text: 'Hello' },
        attemptsMade: 0,
      });

      expect(mockIdempotency.claim).not.toHaveBeenCalled();
      expect(mockConversationService.handleIncomingMessage).toHaveBeenCalled();
    });
  });

  describe('a failure must not look like a duplicate', () => {
    // The bug this covers: the marker was written BEFORE handling, so anything
    // that threw afterwards left it set and the BullMQ retry read it as a
    // duplicate and dropped the message for seven days. The reader got nothing.

    const job = (attemptsMade = 0) => ({
      data: { phone: '+242001', text: 'Hello', messageSid: 'wamid.boom' },
      attemptsMade,
    });

    it('retries the message when the bot graph throws', async () => {
      mockConversationService.handleIncomingMessage
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ replies: ['Bonjour !'], profileId: 'p-1' });

      const processor = makeProcessor();

      // Attempt 1 fails and the error escapes, so BullMQ will retry.
      await expect(processor.process(job(0))).rejects.toThrow('db down');
      expect(mockQueueService.addJob).not.toHaveBeenCalled();

      // Attempt 2 must actually do the work, not treat it as already handled.
      await processor.process(job(1));
      expect(mockConversationService.handleIncomingMessage).toHaveBeenCalledTimes(2);
      expect(mockQueueService.addJob).toHaveBeenCalledTimes(1);
    });

    it('leaves no done marker behind when handling throws', async () => {
      mockConversationService.handleIncomingMessage.mockRejectedValue(
        new Error('db down'),
      );
      const processor = makeProcessor();

      await expect(processor.process(job(0))).rejects.toThrow('db down');

      expect(await mockIdempotency.has(`rabotka:dev:wa:in:done:wamid.boom`)).toBe(
        false,
      );
    });

    it('releases the in-flight lock even when handling throws', async () => {
      // Released in a `finally`, so the TTL is only a backstop for a worker
      // that died. Without this the retry would defer to a flight that ended.
      mockConversationService.handleIncomingMessage.mockRejectedValue(
        new Error('db down'),
      );
      const processor = makeProcessor();

      await expect(processor.process(job(0))).rejects.toThrow('db down');

      expect(await mockIdempotency.has(`rabotka:dev:wa:in:lock:wamid.boom`)).toBe(
        false,
      );
    });

    it('retries when the outbound enqueue throws', async () => {
      // Not just the bot graph — everything before the marker is written.
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Bonjour !'],
        profileId: 'p-1',
      });
      mockQueueService.addJob
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValueOnce(undefined);

      const processor = makeProcessor();
      await expect(processor.process(job(0))).rejects.toThrow('redis down');

      await processor.process(job(1));
      expect(mockQueueService.addJob).toHaveBeenCalledTimes(2);
    });

    it('defers while another attempt holds the lock', async () => {
      redisStore.add(`rabotka:dev:wa:in:lock:wamid.boom`);
      const processor = makeProcessor();

      await expect(processor.process(job(1))).resolves.toBeUndefined();

      expect(
        mockConversationService.handleIncomingMessage,
      ).not.toHaveBeenCalled();
    });
  });
});
