import { Test, TestingModule } from '@nestjs/testing';
import { LogController } from '../log.controller';
import { LogService } from '../log.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';

const mockLogService = {
  listForAdmin: jest
    .fn()
    .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
};

describe('LogController', () => {
  let controller: LogController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LogController],
      providers: [{ provide: LogService, useValue: mockLogService }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<LogController>(LogController);
  });

  it('listAdmin uses defaults when no params given', async () => {
    const result = await controller.listAdmin({});
    expect(mockLogService.listForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 20 }),
    );
    expect(result.total).toBe(0);
  });

  it('listAdmin passes all filters', async () => {
    const dto = {
      page: 2,
      limit: 10,
      q: 'test',
      entity_type: 'Profile',
      created_from: '2026-01-01',
      created_to: '2026-12-31',
    };
    await controller.listAdmin(dto);
    expect(mockLogService.listForAdmin).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      q: 'test',
      entity_type: 'Profile',
      created_from: '2026-01-01',
      created_to: '2026-12-31',
    });
  });
});
