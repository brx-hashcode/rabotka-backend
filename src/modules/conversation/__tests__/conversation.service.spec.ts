import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConversationService } from '../conversation.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotOrchestratorService } from '../../bot/services/bot-orchestrator.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { VovaService } from '../../rag/vova.service';

const PROFILE_ID = 'profile-uuid-1';
const PHONE = '+24200000001';

describe('ConversationService', () => {
  let service: ConversationService;
  let prisma: jest.Mocked<PrismaService>;
  let botOrchestrator: jest.Mocked<BotOrchestratorService>;
  let whatsApp: jest.Mocked<WhatsAppService>;
  let vova: jest.Mocked<VovaService>;

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

    // null is "not handled" — the caller must then send the signup card.
    const mockVova = {
      handleAnonymous: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: BotOrchestratorService, useValue: mockBotOrchestrator },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        {
          provide: REDIS_CONNECTION,
          // `set` returns 'OK' so the per-phone lock is acquired; returning
          // undefined would read as "already locked" and drop every message.
          useValue: {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue('OK'),
            del: jest.fn(),
          },
        },
        { provide: VovaService, useValue: mockVova },
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
    vova = module.get(VovaService);
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

    it('sends an unknown phone to the assistant before falling back', async () => {
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);
      (vova.handleAnonymous as jest.Mock).mockResolvedValue({
        text: 'Rabotka met en relation des travailleurs et des recruteurs.',
        offerAccount: false,
      });

      const result = await service.handleIncomingMessage(
        PHONE,
        'c’est quoi Rabotka ?',
      );

      expect(vova.handleAnonymous).toHaveBeenCalledWith(
        PHONE,
        'c’est quoi Rabotka ?',
      );
      expect(result.profileId).toBeNull();
      expect(result.replies).toEqual([
        'Rabotka met en relation des travailleurs et des recruteurs.',
      ]);
    });

    it('answers /compte with the signup card and no model call', async () => {
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);

      const result = await service.handleIncomingMessage(PHONE, '/compte');

      // The slash is expanded before the branch — it used to be expanded after,
      // so `/compte` reached the matcher still carrying it.
      expect(vova.handleAnonymous).not.toHaveBeenCalled();
      expect(result.replies[0]).toContain('[TPL:welcomeUnregisteredCard]');
    });

    it('sends a bare greeting to the assistant, not the card', async () => {
      // A stranger writing « bonjour » is opening a conversation. A card is the
      // reply you give when you have nothing to say, and here we do — the
      // assistant can greet them and ask what they are looking for.
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);
      (vova.handleAnonymous as jest.Mock).mockResolvedValue({
        text: 'Bonjour ! Je suis VoVa AI, l’assistant de Rabotka.',
        offerAccount: false,
      });

      for (const greeting of ['Bonjour', 'bonjour', 'aide', 'help']) {
        (vova.handleAnonymous as jest.Mock).mockClear();
        const result = await service.handleIncomingMessage(PHONE, greeting);

        expect(vova.handleAnonymous).toHaveBeenCalled();
        expect(result.replies[0]).not.toContain('[TPL:');
      }
    });

    it('keeps the navigation commands deterministic', async () => {
      // These are documented entry points, printed in templates. They must not
      // depend on a model provider being up.
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);

      for (const command of ['menu', 'start', 'démarrer', '/']) {
        (vova.handleAnonymous as jest.Mock).mockClear();
        const result = await service.handleIncomingMessage(PHONE, command);

        expect(vova.handleAnonymous).not.toHaveBeenCalled();
        expect(result.replies[0]).toContain('[TPL:welcomeUnregisteredCard]');
      }
    });

    it('still falls back to the card when the assistant declines a greeting', async () => {
      // vova.enabled=false, over budget, timed out: « bonjour » must not become
      // a worse experience than it was before it reached the assistant.
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);
      (vova.handleAnonymous as jest.Mock).mockResolvedValue(null);

      const result = await service.handleIncomingMessage(PHONE, 'Bonjour');

      expect(result.replies[0]).toContain('[TPL:welcomeUnregisteredCard]');
    });

    it('sends the landing page CTA to the assistant, not the card', async () => {
      // Exact matching, not prefix: this message begins with "bonjour" and is
      // the first thing a new user ever sends. Prefix matching swallowed it.
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);
      (vova.handleAnonymous as jest.Mock).mockResolvedValue({
        text: 'Bien sûr !',
        offerAccount: false,
      });

      const result = await service.handleIncomingMessage(
        PHONE,
        'Bonjour Rabotka, je cherche une opportunité',
      );

      expect(vova.handleAnonymous).toHaveBeenCalled();
      expect(result.replies).toEqual(['Bien sûr !']);
    });

    it('shows the limit message AND the card when the allowance is spent', async () => {
      // The only case that says something and shows the card together: the
      // person is told why the conversation stops, and handed the way to
      // continue it in the same breath.
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);
      (vova.handleAnonymous as jest.Mock).mockResolvedValue({
        text: 'J’ai répondu à toutes les questions… Créez votre compte.',
        offerAccount: true,
      });

      const result = await service.handleIncomingMessage(PHONE, 'et après ?');

      expect(result.replies).toHaveLength(2);
      expect(result.replies[0]).toContain('Créez votre compte');
      expect(result.replies[1]).toContain('[TPL:welcomeUnregisteredCard]');
    });

    it('writes nothing to Postgres for an unknown phone', async () => {
      // Both tables require a profile_id; there is no row to attach to.
      (botOrchestrator.loadProfileByPhone as jest.Mock).mockResolvedValue(null);
      (vova.handleAnonymous as jest.Mock).mockResolvedValue({
        text: 'Voilà.',
        offerAccount: false,
      });

      await service.handleIncomingMessage(PHONE, 'comment ça marche ?');

      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(whatsApp.saveMessage).not.toHaveBeenCalled();
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
