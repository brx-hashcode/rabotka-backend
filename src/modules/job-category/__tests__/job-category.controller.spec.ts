import { Test, TestingModule } from '@nestjs/testing';
import {
  JobCategoryController,
  AdminJobCategoryController,
} from '../job-category.controller';
import { JobCategoryService } from '../job-category.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';

const fakeReq = () =>
  ({
    user: { userId: 'admin-1' },
    headers: {},
    ip: '127.0.0.1',
    get: () => undefined,
  }) as any;

const mockService = {
  findAll: jest.fn().mockResolvedValue([{ id: 'cat-1', name: 'Plomberie' }]),
  // Admin-only variant: same domains plus usage counts. Kept off `findAll`
  // because that one also serves the public endpoint.
  findAllForAdmin: jest.fn().mockResolvedValue([
    { id: 'cat-1', name: 'Plomberie', jobOffersCount: 3, workersCount: 7 },
  ]),
  create: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Plomberie' }),
  update: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Updated' }),
  remove: jest.fn().mockResolvedValue(undefined),
};

describe('JobCategoryController (public)', () => {
  let controller: JobCategoryController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobCategoryController],
      providers: [{ provide: JobCategoryService, useValue: mockService }],
    }).compile();
    controller = module.get<JobCategoryController>(JobCategoryController);
  });

  it('lists all categories', async () => {
    const result = await controller.findAll();
    expect(result).toHaveLength(1);
  });

  it('does not pay for admin usage counts', async () => {
    await controller.findAll();
    // The public endpoint is hit on every signup and offer form; aggregate
    // subselects there would be cost with no caller.
    expect(mockService.findAllForAdmin).not.toHaveBeenCalled();
  });
});

describe('AdminJobCategoryController', () => {
  let controller: AdminJobCategoryController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminJobCategoryController],
      providers: [
        { provide: JobCategoryService, useValue: mockService },
        { provide: LogService, useValue: { create: jest.fn() } },
      ],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdminJobCategoryController>(
      AdminJobCategoryController,
    );
  });

  it('lists all categories with usage counts', async () => {
    const result = await controller.findAll();
    expect(result).toHaveLength(1);
    expect(mockService.findAllForAdmin).toHaveBeenCalled();
    expect(result[0]).toMatchObject({ jobOffersCount: 3, workersCount: 7 });
  });

  it('creates a category', async () => {
    const result = await controller.create(fakeReq(), {
      name: 'Plomberie',
      slug: 'plomberie',
    });
    expect(result.id).toBe('cat-1');
  });

  it('updates a category', async () => {
    const result = await controller.update(fakeReq(), 'cat-1', {
      name: 'Updated',
    });
    expect(result.name).toBe('Updated');
  });

  it('removes a category', async () => {
    await controller.remove(fakeReq(), 'cat-1');
    expect(mockService.remove).toHaveBeenCalledWith('cat-1');
  });
});
