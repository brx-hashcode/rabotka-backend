import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { KycService } from '../kyc.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

const mockPrisma = {
  profile: {
    findUnique: jest.fn(),
  },
};

const mockWhatsApp = {
  sendTextMessage: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue('http://localhost:3000'),
};

const mockRedis = {
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
};

const mockProfile = {
  id: 'profile-1',
  first_name: 'Alice',
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
        { provide: ConfigService, useValue: mockConfigService },
        { provide: REDIS_CONNECTION, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<KycService>(KycService);
  });

  describe('approveKyc', () => {
    it('approves KYC and sends WhatsApp message', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      mockWhatsApp.sendTextMessage.mockResolvedValue(true);

      await service.approveKyc('profile-1');
      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockWhatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('throws NotFoundException when profile not found', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.approveKyc('x')).rejects.toThrow(NotFoundException);
    });

    it('deletes redis key and throws when WhatsApp fails', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      mockWhatsApp.sendTextMessage.mockResolvedValue(false);

      await expect(service.approveKyc('profile-1')).rejects.toThrow();
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('continues even when second WhatsApp message fails', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(mockProfile);
      mockWhatsApp.sendTextMessage
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('WhatsApp error'));

      await service.approveKyc('profile-1');
    });
  });
});
