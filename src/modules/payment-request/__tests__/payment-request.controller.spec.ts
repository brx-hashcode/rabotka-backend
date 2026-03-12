import { PaymentRequestController } from '../payment-request.controller';
import { PaymentRequestPublicController } from '../payment-request-public.controller';

function makeService() {
  return {
    createPaymentLink: jest.fn().mockResolvedValue({ id: 'pr1', token: 'tok' }),
    getList: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    approve: jest.fn().mockResolvedValue({ id: 'pr1' }),
    reject: jest.fn().mockResolvedValue({ id: 'pr1' }),
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

  it('createPaymentLink() delegates to service', () => {
    const req = { user: { id: 'u1' } };
    controller.createPaymentLink({ profileId: 'p1' } as any, req);
    expect(service.createPaymentLink).toHaveBeenCalledWith({ profileId: 'p1' }, 'u1');
  });

  it('getList() delegates to service', () => {
    controller.getList({ page: 1 } as any);
    expect(service.getList).toHaveBeenCalledWith({ page: 1 });
  });

  it('approve() delegates to service', () => {
    const req = { user: { id: 'u1' } };
    controller.approve('pr1', req);
    expect(service.approve).toHaveBeenCalledWith('pr1', 'u1');
  });

  it('reject() delegates to service', () => {
    const req = { user: { id: 'u1' } };
    controller.reject('pr1', { reason: 'wrong' } as any, req);
    expect(service.reject).toHaveBeenCalledWith('pr1', { reason: 'wrong' }, 'u1');
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
