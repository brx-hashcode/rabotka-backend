import { Test, TestingModule } from '@nestjs/testing';
import { SystemConfigPublicController } from '../system-config-public.controller';
import { SystemConfigService } from '../system-config.service';

const mockSystemConfigService = {
  getContactInfo: jest.fn(),
  getWelcomeCredits: jest.fn(),
  getFees: jest.fn(),
};

describe('SystemConfigPublicController', () => {
  let controller: SystemConfigPublicController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SystemConfigPublicController],
      providers: [
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    }).compile();

    controller = module.get(SystemConfigPublicController);
  });

  describe('getApplicationTerms', () => {
    it('exposes only the penalty and threshold, never the rest of the fees', async () => {
      mockSystemConfigService.getFees.mockResolvedValue({
        lateCancellationPenaltyFcfa: 5000,
        cancellationThresholdHours: 4,
        recommendationFeeFcfa: 2000,
        billingBlockThresholdFcfa: 10000,
      });

      const terms = await controller.getApplicationTerms();

      expect(terms).toEqual({
        lateCancellationPenaltyFcfa: 5000,
        cancellationThresholdHours: 4,
      });
    });
  });
});
