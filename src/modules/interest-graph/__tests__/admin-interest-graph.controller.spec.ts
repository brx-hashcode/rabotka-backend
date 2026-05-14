import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminInterestGraphController } from '../admin-interest-graph.controller';
import { InterestClusterService } from '../interest-cluster.service';
import { InterestSignalService } from '../interest-signal.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const mockClusters = {
  getProfile: jest.fn(),
  reseedFromProfile: jest.fn().mockResolvedValue(undefined),
};

const mockSignals = {
  getRecentSignals: jest.fn().mockResolvedValue([{ jobId: 'job-1', type: 'apply' }]),
};

describe('AdminInterestGraphController', () => {
  let controller: AdminInterestGraphController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminInterestGraphController],
      providers: [
        { provide: InterestClusterService, useValue: mockClusters },
        { provide: InterestSignalService, useValue: mockSignals },
      ],
    })
      .overrideGuard(AdminAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdminInterestGraphController>(AdminInterestGraphController);
  });

  it('getProfile returns profile when found', async () => {
    const profile = { positiveVectors: [], negativeVectors: [], categories: [], seenJobIds: [], totalSignals: 5 };
    mockClusters.getProfile.mockResolvedValueOnce(profile);
    const result = await controller.getProfile('user-1');
    expect(result).toEqual(profile);
  });

  it('getProfile throws NotFoundException when not found', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(null);
    await expect(controller.getProfile('user-1')).rejects.toThrow(NotFoundException);
  });

  it('getSignals returns recent signals', async () => {
    const result = await controller.getSignals('user-1');
    expect(mockSignals.getRecentSignals).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(1);
  });

  it('reseed triggers cluster reseed', async () => {
    await controller.reseed('user-1');
    expect(mockClusters.reseedFromProfile).toHaveBeenCalledWith('user-1');
  });
});
