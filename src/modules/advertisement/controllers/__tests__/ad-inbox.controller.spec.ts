import { Test, TestingModule } from '@nestjs/testing';
import { AdInboxController } from '../ad-inbox.controller';
import { AdInboxService } from '../../services/ad-inbox.service';
import { ProfileAuthGuard } from '../../../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../../../auth/guards/jwt-auth.guard';

const mockAdInboxService = {
  listPending: jest.fn().mockResolvedValue([]),
  markSeen: jest.fn().mockResolvedValue(undefined),
};

const req = {
  user: { profileId: 'profile-1', type: 'profile' },
} as ProfileAuthenticatedRequest;

describe('AdInboxController', () => {
  let controller: AdInboxController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdInboxController],
      providers: [{ provide: AdInboxService, useValue: mockAdInboxService }],
    })
      .overrideGuard(ProfileAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdInboxController>(AdInboxController);
  });

  it('lists pending ads for the authenticated profile only', () => {
    controller.list(req);
    expect(mockAdInboxService.listPending).toHaveBeenCalledWith('profile-1');
  });

  it('dismisses a delivery on behalf of the authenticated profile', async () => {
    await controller.markSeen(req, 'dl-1');
    expect(mockAdInboxService.markSeen).toHaveBeenCalledWith(
      'profile-1',
      'dl-1',
    );
  });
});
