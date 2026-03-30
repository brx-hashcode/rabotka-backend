import { PaymentRequestController } from '../payment-request.controller';
import { PaymentRequestPublicController } from '../payment-request-public.controller';

function makeService() {
  return {
    getList: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    getByToken: jest.fn().mockResolvedValue({ id: 'pr1', token: 'tok' }),
    submitPayment: jest.fn().mockResolvedValue({ id: 'pr1' }),
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

describe('PaymentRequestPublicController', () => {
  let controller: PaymentRequestPublicController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentRequestPublicController(service as any);
  });

  it('getByToken() delegates to service', () => {
    controller.getByToken('tok');
    expect(service.getByToken).toHaveBeenCalledWith('tok');
  });

  it('submitPayment() delegates to service', () => {
    controller.submitPayment('tok', { proofUrl: 'http://img.jpg' } as any);
    expect(service.submitPayment).toHaveBeenCalledWith('tok', { proofUrl: 'http://img.jpg' });
  });
});
