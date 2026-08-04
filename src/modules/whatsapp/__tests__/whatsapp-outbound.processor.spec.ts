import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WhatsAppOutboundProcessor } from '../whatsapp-outbound.processor';
import { WhatsAppService } from '../whatsapp.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WhatsAppLoginLinkService } from '../../auth/whatsapp-login-link.service';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';

const mockWhatsApp = {
  sendTextMessage: jest.fn().mockResolvedValue('SM-sid-123'),
  sendMediaMessage: jest.fn().mockResolvedValue('SM-sid-456'),
  sendTemplateMessage: jest.fn().mockResolvedValue('SM-sid-789'),
  saveMessage: jest.fn().mockResolvedValue(undefined),
};

const mockLoginLink = {
  // Default: no login code attached, so existing expectations stay exact.
  appendTo: jest.fn().mockImplementation((_id: string, target: string) => target),
  mint: jest.fn().mockResolvedValue('CODE123'),
  shortLink: jest.fn().mockResolvedValue(null),
};

const mockQueueService = {
  createWorker: jest.fn().mockReturnValue({
    on: jest.fn(),
  }),
  addJob: jest.fn().mockResolvedValue(undefined),
};

describe('WhatsAppOutboundProcessor', () => {
  let processor: WhatsAppOutboundProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppOutboundProcessor,
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: WhatsAppLoginLinkService, useValue: mockLoginLink },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => 'https://rabotka.work') },
        },
      ],
    }).compile();
    processor = module.get<WhatsAppOutboundProcessor>(
      WhatsAppOutboundProcessor,
    );
  });

  it('register creates worker with queue service', () => {
    processor.register(mockQueueService as any);
    expect(mockQueueService.createWorker).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ concurrency: 3 }),
    );
    const worker = mockQueueService.createWorker.mock.results[0].value;
    expect(worker.on).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('process sends text message', async () => {
    await processor.process({
      data: { type: 'text', phone: '+242001', text: 'Hello', profileId: 'p1' },
    });
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
      '+242001',
      'Hello',
      'p1',
    );
  });

  it('process sends a sequence in array order', async () => {
    const order: string[] = [];
    mockWhatsApp.sendTemplateMessage.mockImplementationOnce(() => {
      order.push('template');
      return Promise.resolve('SM-tpl');
    });
    mockWhatsApp.sendTextMessage.mockImplementationOnce(() => {
      order.push('text');
      return Promise.resolve('SM-txt');
    });

    await processor.process({
      data: {
        type: 'sequence',
        phone: '+242001',
        profileId: 'p1',
        messages: [
          {
            type: 'template',
            contentSid: 'HXcarousel',
            contentVariables: { '1': 'x' },
          },
          { type: 'text', text: 'Page 1/3' },
        ],
      },
    });

    // Carousel before its pagination line — the ordering the race used to break.
    expect(order).toEqual(['template', 'text']);
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
      '+242001',
      'Page 1/3',
      'p1',
    );
  });

  it('process throws when text message returns no SID', async () => {
    mockWhatsApp.sendTextMessage.mockResolvedValueOnce(null);
    await expect(
      processor.process({
        data: { type: 'text', phone: '+242001', text: 'Hello' },
      }),
    ).rejects.toThrow('returned no SID');
  });

  it('process sends media message', async () => {
    await processor.process({
      data: {
        type: 'media',
        phone: '+242001',
        mediaUrl: 'https://img.com/1.jpg',
        caption: 'Caption',
        profileId: 'p1',
      },
    });
    expect(mockWhatsApp.sendMediaMessage).toHaveBeenCalledWith(
      '+242001',
      'https://img.com/1.jpg',
      'Caption',
    );
    expect(mockWhatsApp.saveMessage).toHaveBeenCalled();
  });

  it('process sends a template (carousel) message', async () => {
    await processor.process({
      data: {
        type: 'template',
        phone: '+242001',
        contentSid: 'HXcarousel',
        contentVariables: { '1': 'https://img/1.png', '2': '*Card*' },
        profileId: 'p1',
      },
    });
    expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      '+242001',
      'HXcarousel',
      { '1': 'https://img/1.png', '2': '*Card*' },
    );
    expect(mockWhatsApp.saveMessage).toHaveBeenCalledWith(
      'p1',
      expect.any(String),
      '[TPL:HXcarousel]',
    );
  });

  it('process throws when template returns no SID', async () => {
    mockWhatsApp.sendTemplateMessage.mockResolvedValueOnce(null);
    await expect(
      processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: 'HXcarousel',
          contentVariables: {},
        },
      }),
    ).rejects.toThrow('returned no SID');
  });

  // Regression: a bookkeeping (saveMessage) failure after a delivered template
  // must NOT fail the job — a failed job is retried and would resend the
  // template (the recommended-profiles duplicate-card bug).
  it('does not throw or resend when saveMessage fails after a delivered template', async () => {
    mockWhatsApp.saveMessage.mockRejectedValueOnce(new Error('db down'));
    await expect(
      processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: 'HXcarousel',
          contentVariables: { '1': 'x' },
          profileId: 'p1',
        },
      }),
    ).resolves.toBeUndefined();
    // Sent exactly once — the job completed, so BullMQ will not retry/resend.
    expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it('process sends media without caption saves proper body', async () => {
    await processor.process({
      data: {
        type: 'media',
        phone: '+242001',
        mediaUrl: 'https://img.com/1.jpg',
        profileId: 'p1',
      },
    });
    expect(mockWhatsApp.saveMessage).toHaveBeenCalledWith(
      'p1',
      expect.any(String),
      '[IMG:https://img.com/1.jpg]',
    );
  });

  it('process sends media without profileId does not save message', async () => {
    await processor.process({
      data: {
        type: 'media',
        phone: '+242001',
        mediaUrl: 'https://img.com/1.jpg',
      },
    });
    expect(mockWhatsApp.saveMessage).not.toHaveBeenCalled();
  });

  it('process throws when media message returns no SID', async () => {
    mockWhatsApp.sendMediaMessage.mockResolvedValueOnce(null);
    await expect(
      processor.process({
        data: {
          type: 'media',
          phone: '+242001',
          mediaUrl: 'https://img.com/1.jpg',
        },
      }),
    ).rejects.toThrow('returned no SID');
  });

  // Regression: a bookkeeping failure after a delivered media message must not
  // fail the job (which would resend the media on retry).
  it('does not throw or resend when saveMessage fails after a delivered media message', async () => {
    mockWhatsApp.saveMessage.mockRejectedValueOnce(new Error('db down'));
    await expect(
      processor.process({
        data: {
          type: 'media',
          phone: '+242001',
          mediaUrl: 'https://img.com/1.jpg',
          profileId: 'p1',
        },
      }),
    ).resolves.toBeUndefined();
    expect(mockWhatsApp.sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it('register - failed handler triggers DLQ when max attempts reached', async () => {
    processor.register(mockQueueService as any);
    const workerMock = mockQueueService.createWorker.mock.results[0].value;
    // Get the failed handler
    const failedHandler = workerMock.on.mock.calls[0][1];

    const job = {
      id: 'job-1',
      data: { type: 'text', phone: '+242001', text: 'Test' },
      opts: { attempts: 3 },
      attemptsMade: 3,
    };
    const err = new Error('Send failed');

    await failedHandler(job, err);
    expect(mockQueueService.addJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ originalJobId: 'job-1' }),
    );
  });

  it('register - failed handler skips DLQ when max attempts not yet reached', async () => {
    processor.register(mockQueueService as any);
    const workerMock = mockQueueService.createWorker.mock.results[0].value;
    const failedHandler = workerMock.on.mock.calls[0][1];

    const job = {
      id: 'job-1',
      data: { type: 'text', phone: '+242001', text: 'Test' },
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await failedHandler(job, new Error('Temp error'));
    expect(mockQueueService.addJob).not.toHaveBeenCalled();
  });

  it('register - failed handler skips when job is null', async () => {
    processor.register(mockQueueService as any);
    const workerMock = mockQueueService.createWorker.mock.results[0].value;
    const failedHandler = workerMock.on.mock.calls[0][1];
    await failedHandler(null, new Error('Error'));
    expect(mockQueueService.addJob).not.toHaveBeenCalled();
  });

  it('register - failed handler logs when DLQ addJob itself fails', async () => {
    mockQueueService.addJob.mockRejectedValueOnce(new Error('DLQ unavailable'));
    processor.register(mockQueueService as any);
    const workerMock = mockQueueService.createWorker.mock.results[0].value;
    const failedHandler = workerMock.on.mock.calls[0][1];

    const job = {
      id: 'job-x',
      data: { type: 'text', phone: '+242001', text: 'Test' },
      opts: { attempts: 3 },
      attemptsMade: 3,
    };
    // Should not throw even when DLQ write fails — handler is fire-and-forget
    await failedHandler(job, new Error('Send failed'));
    expect(mockQueueService.addJob).toHaveBeenCalled();
  });

  it('process splits long text into chunked messages', async () => {
    const longText = 'A'.repeat(1600);
    await processor.process({
      data: { type: 'text', phone: '+242001', text: longText },
    });
    // Must have been called more than once — message was split
    expect(mockWhatsApp.sendTextMessage.mock.calls.length).toBeGreaterThan(1);
    // Each call's text must be prefixed with (i/N)
    const firstCall = mockWhatsApp.sendTextMessage.mock.calls[0][1] as string;
    expect(firstCall).toMatch(/^\(1\/\d+\)/);
  });

  describe('WhatsApp auto-login code', () => {
    // `statusCheck` declares urlSuffixVar '2' — the job-offer id that ends the
    // CTA button's URL.
    const statusCheck = WHATSAPP_TEMPLATES.statusCheck.contentSid;

    it('appends a login code to the CTA URL suffix variable', async () => {
      mockLoginLink.appendTo.mockResolvedValue('offer-9?s=code-1');

      await processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: statusCheck,
          contentVariables: { '1': 'Plomberie', '2': 'offer-9' },
          profileId: 'p1',
        },
      });

      // '&' because the CTA is `…/login?redirect=/missions/{{2}}`: a '?' would
      // bury the code inside the redirect value.
      expect(mockLoginLink.appendTo).toHaveBeenCalledWith('p1', 'offer-9', '&');
      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        statusCheck,
        { '1': 'Plomberie', '2': 'offer-9?s=code-1' },
      );
    });

    it('leaves templates without a URL suffix untouched', async () => {
      await processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: 'HXcarousel',
          contentVariables: { '1': 'x' },
          profileId: 'p1',
        },
      });

      expect(mockLoginLink.appendTo).not.toHaveBeenCalled();
    });

    it('skips minting when the recipient profile is unknown', async () => {
      await processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: statusCheck,
          contentVariables: { '1': 'Plomberie', '2': 'offer-9' },
        },
      });

      expect(mockLoginLink.appendTo).not.toHaveBeenCalled();
      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        statusCheck,
        { '1': 'Plomberie', '2': 'offer-9' },
      );
    });

    it('still sends the template when no code could be attached', async () => {
      // appendTo degrades to the plain target on a Redis failure.
      mockLoginLink.appendTo.mockResolvedValue('offer-9');

      await processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: statusCheck,
          contentVariables: { '1': 'Plomberie', '2': 'offer-9' },
          profileId: 'p1',
        },
      });

      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        statusCheck,
        { '1': 'Plomberie', '2': 'offer-9' },
      );
    });
  });

  describe('short-link templates', () => {
    // `kycPendingMenu` is `urlSuffixMode: 'shortlink'`: its approved URL is the
    // fixed `…/s/{{1}}`, so the variable must be REPLACED by a code, never
    // appended to. Any shortlink template would do — this one stands in for the
    // mode, not for itself.
    const shortlinkTpl = WHATSAPP_TEMPLATES.kycPendingMenu.contentSid;

    it('swaps the destination for a freshly minted code', async () => {
      await processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: shortlinkTpl,
          contentVariables: { '1': 'profile' },
          profileId: 'p1',
        },
      });

      expect(mockLoginLink.mint).toHaveBeenCalledWith('p1', 'profile');
      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        shortlinkTpl,
        { '1': 'CODE123' },
      );
      expect(mockLoginLink.appendTo).not.toHaveBeenCalled();
    });

    it('leaves the destination alone when no code could be minted', async () => {
      // Sending `/s/profile` would be a dead link; the untouched template
      // at least reaches the login fallback.
      mockLoginLink.mint.mockResolvedValueOnce(null);

      await processor.process({
        data: {
          type: 'template',
          phone: '+242001',
          contentSid: shortlinkTpl,
          contentVariables: { '1': 'profile' },
          profileId: 'p1',
        },
      });

      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242001',
        shortlinkTpl,
        { '1': 'profile' },
      );
    });
  });

  describe('plain-text links', () => {
    it('rewrites a first-party link into a one-tap short link', async () => {
      mockLoginLink.shortLink.mockResolvedValue('https://rabotka.work/s/CODE');

      await processor.process({
        data: {
          type: 'text',
          phone: '+242001',
          profileId: 'p1',
          text: 'Payez ici : https://rabotka.work/pay/tok-1',
        },
      });

      expect(mockLoginLink.shortLink).toHaveBeenCalledWith('p1', '/pay/tok-1');
      expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+242001',
        'Payez ici : https://rabotka.work/s/CODE',
        'p1',
      );
    });

    it.each([
      ['https://wa.me/242069917686', 'wa.me is not ours'],
      ['https://rabotka.work/r/abc123', 'ad links resolve themselves'],
      ['https://rabotka.work/verify/whatsapp?token=x', 'carries its own token'],
    ])('leaves %s alone (%s)', async (url) => {
      await processor.process({
        data: { type: 'text', phone: '+242001', profileId: 'p1', text: url },
      });

      expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+242001',
        url,
        'p1',
      );
    });

    it('does not rewrite when the recipient profile is unknown', async () => {
      await processor.process({
        data: {
          type: 'text',
          phone: '+242001',
          text: 'https://rabotka.work/pay/tok-1',
        },
      });

      expect(mockLoginLink.shortLink).not.toHaveBeenCalled();
    });
  });
});
