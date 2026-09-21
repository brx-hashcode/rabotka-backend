import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { KycService } from '../kyc.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { NotificationDispatcher } from '../../notification-dispatch/notification-dispatcher.service';

const mockPrisma = {
  profile: {
    findUnique: jest.fn(),
  },
};

const mockWhatsApp = {
  sendTemplateMessage: jest.fn(),
};

// The approval goes through the dispatcher now: free-form with a button while
// the 24h window is open, the approved `kyc` template otherwise.
const mockDispatcher = {
  send: jest.fn(),
};

const mockProfile = {
  id: 'profile-1',
  first_name: 'Alice',
  last_name: 'Smith',
  phone: '+242000001',
};

describe('KycService', () => {
  let service: KycService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: NotificationDispatcher, useValue: mockDispatcher },
      ],
    }).compile();
    service = module.get<KycService>(KycService);
  });

  describe('approveKyc', () => {
    it('approves KYC and sends the WhatsApp approval template', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      mockDispatcher.send.mockResolvedValue({ mode: 'TEMPLATE', sent: true });

      await service.approveKyc('profile-1');

      expect(mockDispatcher.send).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: mockProfile.phone,
          profileId: mockProfile.id,
          template: { key: 'kyc', params: 'Alice Smith' },
          freeForm: expect.objectContaining({ path: 'home' }),
        }),
      );
    });

    it('throws NotFoundException when profile not found', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.approveKyc('x')).rejects.toThrow(NotFoundException);
    });

    it('throws when the WhatsApp template fails to send', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      // Both paths failed — the free-form send AND the template it falls back
      // to. An approval nobody was told about must still fail loudly.
      mockDispatcher.send.mockResolvedValue({ mode: 'TEMPLATE', sent: false });

      await expect(service.approveKyc('profile-1')).rejects.toThrow();
    });
  });
});
