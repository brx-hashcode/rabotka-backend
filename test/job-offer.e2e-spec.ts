/**
 * E2E integration tests for JobOfferService.
 * Tests the service layer with a mocked PrismaService.
 * No REST controllers exist for job-offers (bot-only), so we test the service directly.
 */
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JobOfferService } from '../src/modules/job-offer/job-offer.service';
import { PrismaService } from '../src/common/services/prisma/prisma.service';
import { PaymentFlow } from '@prisma/client';

const EMPLOYER_ID = 'employer-e2e-1';
const OFFER_ID = 'offer-e2e-1';

function futureDate(hoursFromNow = 5): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const validDto = {
  title: 'Plombier pour réparation urgente',
  description: 'Réparation fuite eau cuisine, remplacement robinet complet.',
  scheduled_at: futureDate(5),
  amount: 15000,
  payment_flow: PaymentFlow.DAILY,
  address: '123 Avenue de la Paix, Poto-Poto',
  quantity: 2,
};

const mockOffer = {
  id: OFFER_ID,
  employer_id: EMPLOYER_ID,
  ...validDto,
  scheduled_at: new Date(futureDate(5)),
  amount: 15000,
  note: null,
  status: 'ACTIVE',
  created_at: new Date(),
  updated_at: new Date(),
};

const mockPrisma = {
  profile: { findUnique: jest.fn() },
  jobOffer: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

describe('JobOfferService (e2e integration)', () => {
  let service: JobOfferService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobOfferService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<JobOfferService>(JobOfferService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.profile.findUnique.mockResolvedValue({
      id: EMPLOYER_ID,
      status: 'ACTIVE',
      profile_type: 'EMPLOYER',
    });
    mockPrisma.jobOffer.create.mockResolvedValue(mockOffer);
    mockPrisma.jobOffer.findMany.mockResolvedValue([mockOffer]);
    mockPrisma.jobOffer.findUnique.mockResolvedValue({
      ...mockOffer,
      employer: {
        id: EMPLOYER_ID,
        first_name: 'John',
        last_name: 'Doe',
        phone: '+242000000',
      },
    });
  });

  describe('POST /job-offers (create)', () => {
    it('creates offer with valid data + quantity → returns offer with quantity', async () => {
      const result = await service.create(EMPLOYER_ID, validDto);
      expect(result.id).toBe(OFFER_ID);
      expect(result.quantity).toBe(2);
    });

    it('defaults quantity to 1 when not provided', async () => {
      const dtoWithoutQty = { ...validDto, quantity: undefined as any };
      mockPrisma.jobOffer.create.mockResolvedValue({
        ...mockOffer,
        quantity: 1,
      });
      const result = await service.create(EMPLOYER_ID, dtoWithoutQty);
      expect(result.quantity).toBe(1);
    });

    it('quantity = 0 → throws BadRequestException (400)', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...validDto, quantity: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('quantity = 101 → throws BadRequestException (400)', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...validDto, quantity: 101 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('non-employer profile → throws ForbiddenException (403)', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      await expect(service.create(EMPLOYER_ID, validDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('employer not found → throws NotFoundException (404)', async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.create(EMPLOYER_ID, validDto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /job-offers (findActive)', () => {
    it('returns list with quantity field', async () => {
      const { data } = await service.findActive(5);
      expect(data).toHaveLength(1);
      expect(data[0]).toHaveProperty('quantity', 2);
    });
  });

  describe('GET /job-offers/:id (findById)', () => {
    it('returns detail with quantity field', async () => {
      const result = await service.findById(OFFER_ID);
      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(2);
    });
  });
});
