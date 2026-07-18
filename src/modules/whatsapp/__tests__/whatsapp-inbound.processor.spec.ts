import { WhatsAppInboundProcessor } from '../whatsapp-inbound.processor';

const mockConversationService = {
  handleIncomingMessage: jest.fn(),
};

const mockQueueService = {
  createWorker: jest.fn().mockReturnValue({}),
  addJob: jest.fn().mockResolvedValue(undefined),
};

function makeProcessor() {
  return new WhatsAppInboundProcessor(
    mockConversationService as any,
    mockQueueService as any,
  );
}

describe('WhatsAppInboundProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      await processor.process({ data: { phone: '+242001', text: 'Hello' } });

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
      await processor.process({ data: { phone: '+242001', text: 'photo' } });

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
      await processor.process({ data: { phone: '+242001', text: 'photo' } });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.objectContaining({ type: 'media', caption: undefined }),
      );
    });

    it('enqueues a template outbound job for a [TPL:sid]{vars} reply', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['[TPL:HXcarousel]{"1":"https://img/1.png","2":"*Card*"}'],
        profileId: 'p-1',
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'menu' } });

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.stringContaining('whatsapp'),
        expect.objectContaining({
          type: 'template',
          phone: '+242001',
          contentSid: 'HXcarousel',
          contentVariables: { '1': 'https://img/1.png', '2': '*Card*' },
        }),
      );
    });

    it('skips a [TPL:] reply with invalid JSON variables', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['[TPL:HXcarousel]{not-json}'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'menu' } });

      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });

    it('skips null/empty replies', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: [null, '', 'Valid reply'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'hi' } });

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
      await processor.process({ data: { phone: '+242001', text: 'hi' } });

      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });

    it('passes profileId as undefined when null', async () => {
      mockConversationService.handleIncomingMessage.mockResolvedValue({
        replies: ['Hello'],
        profileId: null,
      });

      const processor = makeProcessor();
      await processor.process({ data: { phone: '+242001', text: 'hi' } });

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
      await processor.process({ data: { phone: '+242001', text: 'hi' } });

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
});
