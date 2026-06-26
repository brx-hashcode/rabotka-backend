import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ResumeService } from '../resume.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import {
  ProfileType,
  VerificationStatus,
  AssignmentStatus,
  PaymentFlow,
} from '@prisma/client';

const PROFILE_ID = 'profile-uuid-1';

const mockProfile = {
  first_name: 'Alex',
  last_name: 'Makaya',
  email: 'alex.makaya@email.cg',
  phone: '+242 06 555 41 20',
  address: 'Quartier Moungali, Brazzaville',
  description: 'Travailleur polyvalent basé à Brazzaville.',
  profile_type: ProfileType.WORKER,
  verification_status: VerificationStatus.VERIFIED,
  created_at: new Date('2024-03-01T00:00:00Z'),
  categories: [
    {
      profile_id: PROFILE_ID,
      category_id: 'cat-1',
      category: { name: 'Bricolage' },
    },
  ],
};

const mockAssignment = {
  id: 'assign-1',
  application_id: 'app-1',
  job_offer_id: 'offer-1',
  worker_id: PROFILE_ID,
  status: AssignmentStatus.COMPLETED,
  completed_at: new Date('2026-06-22T00:00:00Z'),
  job_offer: {
    title: 'Déménagement appartement',
    address: 'Moungali, Brazzaville',
    amount: 45000,
    scheduled_at: new Date('2026-06-22T00:00:00Z'),
    payment_flow: PaymentFlow.DAILY,
    employer: { first_name: 'Mme', last_name: 'Soudan' },
  },
};

describe('ResumeService', () => {
  let service: ResumeService;
  let prisma: {
    profile: { findUnique: jest.Mock };
    assignment: { findMany: jest.Mock; count: jest.Mock };
  };
  let redis: { get: jest.Mock; setex: jest.Mock };
  let renderSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      profile: { findUnique: jest.fn() },
      assignment: {
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    redis = { get: jest.fn(), setex: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResumeService,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get<ResumeService>(ResumeService);

    renderSpy = jest
      .spyOn(service as any, 'renderHtmlToPdf')
      .mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
  });

  it('returns a cached PDF without re-rendering', async () => {
    redis.get.mockResolvedValue(Buffer.from('cached-pdf').toString('base64'));
    prisma.profile.findUnique.mockResolvedValue({
      first_name: 'Alex',
      last_name: 'Makaya',
    });

    const result = await service.download(PROFILE_ID);

    expect(result.buffer.toString()).toBe('cached-pdf');
    expect(result.filename).toBe('Alex_Makaya_resume.pdf');
    expect(prisma.assignment.findMany).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the profile does not exist', async () => {
    redis.get.mockResolvedValue(null);
    prisma.profile.findUnique.mockResolvedValue(null);

    await expect(service.download(PROFILE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('generates a PDF with a sanitized filename from accomplished jobs', async () => {
    redis.get.mockResolvedValue(null);
    prisma.profile.findUnique.mockResolvedValue(mockProfile);
    prisma.assignment.count.mockResolvedValue(12);
    prisma.assignment.findMany.mockResolvedValue([mockAssignment]);

    const result = await service.download(PROFILE_ID);

    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.filename).toBe('Alex_Makaya_resume.pdf');

    // Lists only a capped number of missions (page fit).
    expect(prisma.assignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { worker_id: PROFILE_ID, status: 'COMPLETED' },
        orderBy: { completed_at: 'desc' },
        take: 5,
      }),
    );

    const html = renderSpy.mock.calls[0][0] as string;
    expect(html).toContain('Alex Makaya');
    expect(html).toContain('Travailleur Vérifié');
    expect(html).toContain('Bricolage');
    expect(html).toContain('Déménagement appartement');
    expect(html).toContain('FCFA');
    // Stat strip shows the lifetime total (12), not the listed count (1).
    expect(html).toContain('>12<');
    expect(html).toContain('1 sur 12');

    expect(redis.setex).toHaveBeenCalledWith(
      `rabotka:dev:pdf:resume:${PROFILE_ID}`,
      3600,
      expect.any(String),
    );
  });

  it('renders the empty-state when the worker has no completed jobs', async () => {
    redis.get.mockResolvedValue(null);
    prisma.profile.findUnique.mockResolvedValue({
      ...mockProfile,
      verification_status: VerificationStatus.PENDING,
      categories: [],
    });
    prisma.assignment.findMany.mockResolvedValue([]);

    const result = await service.download(PROFILE_ID);

    expect(result.buffer.length).toBeGreaterThan(0);
    const html = renderSpy.mock.calls[0][0] as string;
    expect(html).toContain('Aucune expérience pour le moment.');
    expect(html).toContain('Travailleur Non vérifié');
  });
});
