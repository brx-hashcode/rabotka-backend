import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { KycService } from '../kyc.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';

const mockPrisma = {
  profile: {
    findUnique: jest.fn(),
  },
};

const mockWhatsApp = {
  sendTemplateMessage: jest.fn(),
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
      ],
    }).compile();
    service = module.get<KycService>(KycService);
  });

  describe('approveKyc', () => {
    it('approves KYC and sends the WhatsApp approval template', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      mockWhatsApp.sendTemplateMessage.mockResolvedValue(true);

      await service.approveKyc('profile-1');

      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        mockProfile.phone,
        'kyc',
        'Alice Smith',
        mockProfile.id,
      );
    });

    it('throws NotFoundException when profile not found', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.approveKyc('x')).rejects.toThrow(NotFoundException);
    });

    it('throws when the WhatsApp template fails to send', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      mockWhatsApp.sendTemplateMessage.mockResolvedValue(false);

      await expect(service.approveKyc('profile-1')).rejects.toThrow();
    });
  });
});
