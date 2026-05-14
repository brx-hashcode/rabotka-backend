import { Test, TestingModule } from '@nestjs/testing';
import { KycController } from '../kyc.controller';
import { KycService } from '../kyc.service';

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
    }).compile();
    controller = module.get<KycController>(KycController);
  });

  it('approveKyc calls service and returns ok', async () => {
    const result = await controller.approveKyc('profile-1');
    expect(mockKycService.approveKyc).toHaveBeenCalledWith('profile-1');
    expect(result).toEqual({ ok: true });
  });
});
