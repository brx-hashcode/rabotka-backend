import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppOutboundProcessor } from '../whatsapp-outbound.processor';
import { WhatsAppService } from '../whatsapp.service';
import { QueueService } from '../../../common/services/queue/queue.service';

const mockWhatsApp = {
  sendTextMessage: jest.fn().mockResolvedValue('SM-sid-123'),
  sendMediaMessage: jest.fn().mockResolvedValue('SM-sid-456'),
  saveMessage: jest.fn().mockResolvedValue(undefined),
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
      ],
    }).compile();
    processor = module.get<WhatsAppOutboundProcessor>(
      WhatsAppOutboundProcessor,
    );
  });

  it('register creates worker with queue service', () => {
    processor.register(mockQueueService as any);
    expect(mockQueueService.createWorker).toHaveBeenCalled();
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
});
