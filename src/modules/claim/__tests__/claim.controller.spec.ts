import { Test, TestingModule } from '@nestjs/testing';
import {
  ClaimController,
  ClaimCommentController,
  ProfileClaimController,
  ProfileClaimCommentController,
} from '../claim.controller';
import { ClaimService } from '../claim.service';
import { LogService } from '../../log/log.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';

const mockClaimService = {
  createForAdmin: jest.fn().mockResolvedValue({ id: 'claim-1', title: 'Test' }),
  listForAdmin: jest
    .fn()
    .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
  getByIdForAdmin: jest.fn().mockResolvedValue({ id: 'claim-1' }),
  updateForAdmin: jest
    .fn()
    .mockResolvedValue({ id: 'claim-1', title: 'Updated' }),
  deleteForAdmin: jest.fn().mockResolvedValue(undefined),
  listComments: jest.fn().mockResolvedValue([]),
  addComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
  deleteComment: jest.fn().mockResolvedValue(undefined),
  createForProfile: jest.fn().mockResolvedValue({ id: 'claim-1' }),
  listForProfile: jest
    .fn()
    .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
  getByIdForProfile: jest.fn().mockResolvedValue({ id: 'claim-1' }),
  listCommentsForProfile: jest.fn().mockResolvedValue([]),
  addCommentAsProfile: jest.fn().mockResolvedValue({ id: 'comment-1' }),
  deleteCommentAsProfile: jest.fn().mockResolvedValue(undefined),
};

const mockLogService = {
  create: jest.fn().mockResolvedValue({}),
};

const adminReq = {
  user: { userId: 'user-1' },
  headers: {},
  ip: '127.0.0.1',
  get: () => undefined,
} as any;
const profileReq = { user: { profileId: 'profile-1' } } as any;

describe('ClaimController', () => {
  let controller: ClaimController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClaimController],
      providers: [
        { provide: ClaimService, useValue: mockClaimService },
        { provide: LogService, useValue: mockLogService },
      ],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ClaimController>(ClaimController);
  });

  it('creates claim', async () => {
    const result = await controller.create(adminReq, {
      title: 'Test',
      description: 'Desc',
    });
    expect(result.id).toBe('claim-1');
    expect(mockLogService.create).toHaveBeenCalled();
  });

  it('lists claims', async () => {
    const result = await controller.list({});
    expect(result.total).toBe(0);
  });

  it('gets claim by id', async () => {
    const result = await controller.getById('claim-1');
    expect(result.id).toBe('claim-1');
  });

  it('updates claim', async () => {
    const result = await controller.update(
      'claim-1',
      { title: 'Updated' },
      adminReq,
    );
    expect(result.title).toBe('Updated');
    expect(mockLogService.create).toHaveBeenCalled();
  });

  it('deletes claim', async () => {
    const result = await controller.delete('claim-1', adminReq);
    expect(result).toEqual({ success: true });
    expect(mockLogService.create).toHaveBeenCalled();
  });
});

describe('ClaimCommentController', () => {
  let controller: ClaimCommentController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClaimCommentController],
      providers: [
        { provide: ClaimService, useValue: mockClaimService },
        { provide: LogService, useValue: mockLogService },
      ],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ClaimCommentController>(ClaimCommentController);
  });

  it('lists comments', async () => {
    const result = await controller.list('claim-1');
    expect(result).toEqual([]);
  });

  it('adds comment', async () => {
    const result = await controller.add('claim-1', adminReq, {
      content: 'Test',
    });
    expect(result.id).toBe('comment-1');
  });

  it('removes comment', async () => {
    const result = await controller.remove('claim-1', 'comment-1', adminReq);
    expect(result).toEqual({ success: true });
  });
});

describe('ProfileClaimController', () => {
  let controller: ProfileClaimController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProfileClaimController],
      providers: [{ provide: ClaimService, useValue: mockClaimService }],
    })
      .overrideGuard(ProfileAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ProfileClaimController>(ProfileClaimController);
  });

  it('creates claim as profile', async () => {
    const result = await controller.create(profileReq, {
      title: 'Test',
      description: 'Desc',
    });
    expect(result.id).toBe('claim-1');
  });

  it('lists claims as profile', async () => {
    const result = await controller.list(profileReq);
    expect(result.total).toBe(0);
  });

  it('gets claim by id as profile', async () => {
    const result = await controller.getById('claim-1', profileReq);
    expect(result.id).toBe('claim-1');
  });
});

describe('ProfileClaimCommentController', () => {
  let controller: ProfileClaimCommentController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProfileClaimCommentController],
      providers: [{ provide: ClaimService, useValue: mockClaimService }],
    })
      .overrideGuard(ProfileAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ProfileClaimCommentController>(
      ProfileClaimCommentController,
    );
  });

  it('lists comments as profile', async () => {
    const result = await controller.list('claim-1', profileReq);
    expect(result).toEqual([]);
  });

  it('adds comment as profile', async () => {
    const result = await controller.add('claim-1', profileReq, {
      content: 'Test',
    });
    expect(result.id).toBe('comment-1');
  });

  it('removes comment as profile', async () => {
    const result = await controller.remove('claim-1', 'comment-1', profileReq);
    expect(result).toEqual({ success: true });
  });
});
