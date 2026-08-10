import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConversationService } from '../conversation.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotOrchestratorService } from '../../bot/services/bot-orchestrator.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

const PROFILE_ID = 'profile-uuid-1';
const PHONE = '+24200000001';

describe('ConversationService', () => {
  let service: ConversationService;
  let prisma: jest.Mocked<PrismaService>;
  let botOrchestrator: jest.Mocked<BotOrchestratorService>;
  let whatsApp: jest.Mocked<WhatsAppService>;

  beforeEach(async () => {
    const mockPrismaService = {
      profile: { findUnique: jest.fn() },
      conversation: { upsert: jest.fn().mockResolvedValue({}) },
    };

    const mockBotOrchestrator = {
      handle: jest.fn().mockResolvedValue(['Hello from bot']),
      loadProfileByPhone: jest.fn(),
    };

    const mockWhatsApp = {
      saveMessage: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: BotOrchestratorService, useValue: mockBotOrchestrator },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        {
          provide: REDIS_CONNECTION,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('https://rabotka.work') },
        },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
    prisma = module.get(PrismaService);
    botOrchestrator = module.get(BotOrchestratorService);
    whatsApp = module.get(WhatsAppService);
  });

  describe('handleIncomingMessage()', () => {
    it('returns registration message for unknown phone', async () => {
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);

      const result = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(result.profileId).toBeNull();
      expect(result.replies).toHaveLength(1);
      // Registry, not a literal — see bot-orchestrator.service.spec.ts.
      expect(result.replies[0]).toContain('[TPL:welcomeUnregisteredCard]');
      expect(botOrchestrator.handle).not.toHaveBeenCalled();
    });

    it('upserts conversation, saves message, and calls bot orchestrator', async () => {
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue({
        id: PROFILE_ID,
      });

      const result = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(prisma.conversation.upsert).toHaveBeenCalled();
      expect(whatsApp.saveMessage).toHaveBeenCalledWith(
        PROFILE_ID,
        'INBOUND',
        'Hello',
      );
      expect(botOrchestrator.handle).toHaveBeenCalledWith(
        PROFILE_ID,
        PHONE,
        'Hello',
        { id: PROFILE_ID },
      );
      expect(result.replies).toEqual(['Hello from bot']);
    });

    it('filters out empty/falsy replies from bot', async () => {
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue({
        id: PROFILE_ID,
      });
      (botOrchestrator.handle as jest.Mock).mockResolvedValue([
        'Valid reply',
        '',
        null,
        'Another reply',
      ]);

      const result = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(result.replies).toEqual(['Valid reply', 'Another reply']);
    });

    it('still processes message even if saveMessage throws', async () => {
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue({
        id: PROFILE_ID,
      });
      (whatsApp.saveMessage as jest.Mock).mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(result.replies).toEqual(['Hello from bot']);
    });
  });
});
