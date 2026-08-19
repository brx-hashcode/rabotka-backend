import { Test, TestingModule } from '@nestjs/testing';
import { LogController } from '../log.controller';
import { LogService } from '../log.service';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

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
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<LogController>(LogController);
  });

  /**
   * The audit log carried AdminAuthGuard alone, which made it the one admin
   * route where the lateral allowlist never ran — FINANCE and SUPPORT read it
   * by simply never being checked. Asserted on the metadata because the tests
   * below stub the guards away.
   */
  it('requires RolesGuard and MANAGER, not just an admin token', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      LogController.prototype.listAdmin,
    ) as unknown[] | undefined;
    expect(guards).toEqual(
      expect.arrayContaining([AdminAuthGuard, RolesGuard]),
    );

    const roles = Reflect.getMetadata(
      ROLES_KEY,
      LogController.prototype.listAdmin,
    ) as UserRole[] | undefined;
    expect(roles).toEqual([UserRole.MANAGER]);
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
      entity_type: ['Profile'],
      created_from: '2026-01-01',
      created_to: '2026-12-31',
    };
    await controller.listAdmin(dto);
    expect(mockLogService.listForAdmin).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      q: 'test',
      entity_type: ['Profile'],
      created_from: '2026-01-01',
      created_to: '2026-12-31',
    });
  });
});
