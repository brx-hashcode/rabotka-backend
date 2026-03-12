import { Test, TestingModule } from '@nestjs/testing';
import { ConversationService } from '../conversation.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotOrchestratorService } from '../../bot/services/bot-orchestrator.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';

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
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
    prisma = module.get(PrismaService);
    botOrchestrator = module.get(BotOrchestratorService);
    whatsApp = module.get(WhatsAppService);
  });

  describe('handleIncomingMessage()', () => {
    it('returns empty array for unknown phone', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);

      const replies = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(replies).toEqual([]);
      expect(botOrchestrator.handle).not.toHaveBeenCalled();
    });

    it('upserts conversation, saves message, and calls bot orchestrator', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({ id: PROFILE_ID });

      const replies = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(prisma.conversation.upsert).toHaveBeenCalled();
      expect(whatsApp.saveMessage).toHaveBeenCalledWith(
        PROFILE_ID,
        'INBOUND',
        'Hello',
      );
      expect(botOrchestrator.handle).toHaveBeenCalledWith(PROFILE_ID, PHONE, 'Hello');
      expect(replies).toEqual(['Hello from bot']);
    });

    it('filters out empty/falsy replies from bot', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({ id: PROFILE_ID });
      (botOrchestrator.handle as jest.Mock).mockResolvedValue(['Valid reply', '', null, 'Another reply']);

      const replies = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(replies).toEqual(['Valid reply', 'Another reply']);
    });

    it('still processes message even if saveMessage throws', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({ id: PROFILE_ID });
      (whatsApp.saveMessage as jest.Mock).mockRejectedValue(new Error('DB error'));

      const replies = await service.handleIncomingMessage(PHONE, 'Hello');

      expect(replies).toEqual(['Hello from bot']);
    });
  });
});
