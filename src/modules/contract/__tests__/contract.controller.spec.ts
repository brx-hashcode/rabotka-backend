import { Test, TestingModule } from '@nestjs/testing';
import {
  ContractController,
  AdminContractController,
} from '../contract.controller';
import { ContractService } from '../contract.service';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';

const mockContractService = {
  download: jest.fn().mockResolvedValue({
    buffer: Buffer.from('pdf'),
    filename: 'contract.pdf',
  }),
  downloadAsAdmin: jest.fn().mockResolvedValue({
    buffer: Buffer.from('pdf'),
    filename: 'contract-admin.pdf',
  }),
};

describe('ContractController', () => {
  let controller: ContractController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContractController],
      providers: [{ provide: ContractService, useValue: mockContractService }],
    })
      .overrideGuard(ProfileAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ContractController>(ContractController);
  });

  it('download sets headers and sends PDF', async () => {
    const req = { user: { profileId: 'profile-1' } } as any;
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as any;

    await controller.download('contract-1', req, res);

    expect(mockContractService.download).toHaveBeenCalledWith(
      'contract-1',
      'profile-1',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/pdf',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="contract.pdf"',
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('pdf'));
  });
});

describe('AdminContractController', () => {
  let controller: AdminContractController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminContractController],
      providers: [{ provide: ContractService, useValue: mockContractService }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdminContractController>(AdminContractController);
  });

  it('download sets headers and sends PDF as admin', async () => {
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as any;

    await controller.download('contract-1', res);

    expect(mockContractService.downloadAsAdmin).toHaveBeenCalledWith(
      'contract-1',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/pdf',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="contract-admin.pdf"',
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('pdf'));
  });
});
