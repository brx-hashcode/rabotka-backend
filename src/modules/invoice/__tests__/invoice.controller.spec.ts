import { Test, TestingModule } from '@nestjs/testing';
import {
  InvoiceController,
  AdminInvoiceController,
} from '../invoice.controller';
import { InvoiceService } from '../invoice.service';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';

const mockInvoiceService = {
  listForProfile: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
  download: jest
    .fn()
    .mockResolvedValue({ buffer: Buffer.from('pdf'), filename: 'invoice.pdf' }),
  downloadAsAdmin: jest.fn().mockResolvedValue({
    buffer: Buffer.from('pdf'),
    filename: 'invoice-admin.pdf',
  }),
};

describe('InvoiceController', () => {
  let controller: InvoiceController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvoiceController],
      providers: [{ provide: InvoiceService, useValue: mockInvoiceService }],
    })
      .overrideGuard(ProfileAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<InvoiceController>(InvoiceController);
  });

  it('list returns profile invoices', async () => {
    const req = { user: { profileId: 'profile-1' } } as any;
    const result = await controller.list(req);
    expect(mockInvoiceService.listForProfile).toHaveBeenCalledWith('profile-1');
    expect(result).toHaveLength(1);
  });

  it('download sends PDF', async () => {
    const req = { user: { profileId: 'profile-1' } } as any;
    const res = { setHeader: jest.fn(), send: jest.fn() } as any;

    await controller.download('inv-1', req, res);

    expect(mockInvoiceService.download).toHaveBeenCalledWith(
      'inv-1',
      'profile-1',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/pdf',
    );
    expect(res.send).toHaveBeenCalled();
  });
});

describe('AdminInvoiceController', () => {
  let controller: AdminInvoiceController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminInvoiceController],
      providers: [{ provide: InvoiceService, useValue: mockInvoiceService }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdminInvoiceController>(AdminInvoiceController);
  });

  it('download sends PDF as admin', async () => {
    const res = { setHeader: jest.fn(), send: jest.fn() } as any;
    await controller.download('inv-1', res);
    expect(mockInvoiceService.downloadAsAdmin).toHaveBeenCalledWith('inv-1');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/pdf',
    );
    expect(res.send).toHaveBeenCalled();
  });
});
