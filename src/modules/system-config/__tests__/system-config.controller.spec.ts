import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SystemConfigController } from '../system-config.controller';
import { SystemConfigService } from '../system-config.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const mockSystemConfigService = {
  getAll: jest
    .fn()
    .mockResolvedValue([{ key: 'ENABLE_SIMILARITY', value: 'true' }]),
  getOne: jest
    .fn()
    .mockResolvedValue({ key: 'ENABLE_SIMILARITY', value: 'true' }),
  set: jest.fn().mockResolvedValue(undefined),
};

describe('SystemConfigController', () => {
  let controller: SystemConfigController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SystemConfigController],
      providers: [
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<SystemConfigController>(SystemConfigController);
  });

  it('list returns all config entries', async () => {
    const result = await controller.list();
    expect(mockSystemConfigService.getAll).toHaveBeenCalledWith(undefined);
    expect(result).toHaveLength(1);
  });

  it('list filters by category', async () => {
    await controller.list('PAYMENT' as any);
    expect(mockSystemConfigService.getAll).toHaveBeenCalledWith('PAYMENT');
  });

  it('getOne returns entry when found', async () => {
    const result = await controller.getOne('ENABLE_SIMILARITY');
    expect(result.key).toBe('ENABLE_SIMILARITY');
  });

  it('getOne throws NotFoundException when key not found', async () => {
    mockSystemConfigService.getOne.mockResolvedValueOnce(null);
    await expect(controller.getOne('UNKNOWN_KEY')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update updates config entry', async () => {
    const req = { user: { userId: 'admin-1' } };
    const result = await controller.update(
      'ENABLE_SIMILARITY',
      { value: 'false' },
      req,
    );
    expect(mockSystemConfigService.set).toHaveBeenCalledWith(
      'ENABLE_SIMILARITY',
      'false',
      'admin-1',
    );
    expect(result).toEqual({ success: true });
  });

  it('update throws NotFoundException when key not found', async () => {
    mockSystemConfigService.getOne.mockResolvedValueOnce(null);
    const req = { user: { userId: 'admin-1' } };
    await expect(
      controller.update('UNKNOWN_KEY', { value: 'val' }, req),
    ).rejects.toThrow(NotFoundException);
  });
});
