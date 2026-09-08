import { Test, TestingModule } from '@nestjs/testing';
import { KycController } from '../kyc.controller';
import { KycService } from '../kyc.service';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

const mockKycService = {
  approveKyc: jest.fn().mockResolvedValue(undefined),
};

describe('KycController', () => {
  let controller: KycController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [KycController],
      providers: [{ provide: KycService, useValue: mockKycService }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<KycController>(KycController);
  });

  it('approveKyc calls service and returns ok', async () => {
    const result = await controller.approveKyc('profile-1');
    expect(mockKycService.approveKyc).toHaveBeenCalledWith('profile-1');
    expect(result).toEqual({ ok: true });
  });

  /**
   * The test above stubs the guards, so on its own it would keep passing if
   * somebody deleted them — which is exactly how this endpoint shipped
   * unauthenticated in the first place. Assert the metadata instead of the
   * behaviour: this reads what the decorators declare, not what the stubs do.
   */
  it('is guarded as an admin endpoint requiring MANAGER', () => {
    const guards = Reflect.getMetadata('__guards__', KycController) as
      | unknown[]
      | undefined;
    expect(guards).toEqual(
      expect.arrayContaining([AdminAuthGuard, RolesGuard]),
    );

    const roles = Reflect.getMetadata(
      ROLES_KEY,
      KycController.prototype.approveKyc,
    ) as UserRole[] | undefined;
    expect(roles).toEqual([UserRole.MANAGER]);
  });
});
