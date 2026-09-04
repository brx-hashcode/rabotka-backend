import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SystemConfigController } from '../system-config.controller';
import { SystemConfigService } from '../system-config.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';

const mockSystemConfigService = {
  getAll: jest
    .fn()
    .mockResolvedValue([{ key: 'ENABLE_SIMILARITY', value: 'true' }]),
  getOne: jest
    .fn()
    .mockResolvedValue({ key: 'ENABLE_SIMILARITY', value: 'true' }),
  set: jest.fn().mockResolvedValue(undefined),
  setMany: jest.fn().mockResolvedValue(undefined),
};

const mockLogService = { create: jest.fn() };

describe('SystemConfigController', () => {
  let controller: SystemConfigController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SystemConfigController],
      providers: [
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: LogService, useValue: mockLogService },
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
    const req = {
      user: { userId: 'admin-1' },
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    } as any;
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
    const req = {
      user: { userId: 'admin-1' },
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    } as any;
    await expect(
      controller.update('UNKNOWN_KEY', { value: 'val' }, req),
    ).rejects.toThrow(NotFoundException);
  });

  describe('updateMany', () => {
    const req = {
      user: { userId: 'admin-1' },
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    } as any;

    const values = {
      'fees.referral_commission_type': 'PERCENTAGE',
      'fees.referral_credit_referrer': '60',
      'fees.referral_credit_referee': '40',
    };

    it('hands the whole block to the service as one write', async () => {
      const result = await controller.updateMany({ values }, req);
      expect(mockSystemConfigService.setMany).toHaveBeenCalledWith(
        values,
        'admin-1',
      );
      expect(result).toEqual({ success: true });
    });

    it('writes one audit row per key', async () => {
      await controller.updateMany({ values }, req);
      expect(mockLogService.create).toHaveBeenCalledTimes(3);
    });

    it('rejects an empty body', async () => {
      await expect(controller.updateMany({ values: {} }, req)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockSystemConfigService.setMany).not.toHaveBeenCalled();
    });

    // Named, not just counted: the admin has to know which key was wrong.
    it('names every unknown key and writes nothing', async () => {
      mockSystemConfigService.getOne
        .mockResolvedValueOnce({ key: 'a', value: '1' })
        .mockResolvedValueOnce(null);

      await expect(
        controller.updateMany({ values: { a: '1', 'fees.nope': '2' } }, req),
      ).rejects.toThrow(/fees\.nope/);
      expect(mockSystemConfigService.setMany).not.toHaveBeenCalled();
    });
  });
});
