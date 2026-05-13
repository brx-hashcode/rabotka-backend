import { PaymentRequestController } from '../payment-request.controller';
import { PaymentRequestPublicController } from '../payment-request-public.controller';

function makeService() {
  return {
    getList: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    getByToken: jest.fn().mockResolvedValue({ id: 'pr1', token: 'tok' }),
    initiateMonetbilPayment: jest.fn().mockResolvedValue({ success: true }),
    initiatePayment: jest.fn().mockResolvedValue({ success: true }),
    handleMonetbilCallback: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PaymentRequestController', () => {
  let controller: PaymentRequestController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentRequestController(service as any);
  });

  it('getList() delegates to service', () => {
    controller.getList({ page: 1 } as any);
    expect(service.getList).toHaveBeenCalledWith({ page: 1 });
  });
});

const mockLogService = { create: jest.fn().mockResolvedValue(undefined) };

describe('PaymentRequestPublicController', () => {
  let controller: PaymentRequestPublicController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentRequestPublicController(
      service as any,
      mockLogService as any,
    );
  });

  it('getByToken() delegates to service', () => {
    controller.getByToken('tok');
    expect(service.getByToken).toHaveBeenCalledWith('tok');
  });

  it('initiatePayment() delegates to service', () => {
    controller.initiatePayment('tok', {
      phone: '237600000001',
      operator: 'MTN',
    } as any);
    expect(service.initiatePayment).toHaveBeenCalledWith(
      'tok',
      '237600000001',
      'MTN',
    );
  });
});
