import { Test, TestingModule } from '@nestjs/testing';
import { MatchingController } from '../matching.controller';
import { MatchingService } from '../matching.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const mockMatchingService = {
  indexJobOffer: jest.fn().mockResolvedValue(undefined),
  indexWorker: jest.fn().mockResolvedValue(undefined),
  indexEmployer: jest.fn().mockResolvedValue(undefined),
};

const mockPrisma = {
  jobOffer: {
    findMany: jest.fn().mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]),
  },
  profile: {
    findMany: jest.fn().mockResolvedValue([
      { id: 'worker-1', profile_type: 'WORKER' },
      { id: 'employer-1', profile_type: 'EMPLOYER' },
    ]),
  },
};

describe('MatchingController', () => {
  let controller: MatchingController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MatchingController],
      providers: [
        { provide: MatchingService, useValue: mockMatchingService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<MatchingController>(MatchingController);
  });

  it('reindex returns started message immediately', async () => {
    const result = await controller.reindex();
    expect(result.message).toBe('Re-indexing started in background');
  });
});
