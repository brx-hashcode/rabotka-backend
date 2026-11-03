import { AdminBusinessController } from '../admin-business.controller';

describe('AdminBusinessController', () => {
  const req = { user: { userId: 'admin-1', type: 'admin' } } as any;
  let service: any;
  let logs: { create: jest.Mock };
  let controller: AdminBusinessController;

  beforeEach(() => {
    service = {
      overview: jest.fn().mockResolvedValue({}),
      resendInvite: jest.fn().mockResolvedValue({ email: 'awa@e.cg' }),
      removeMember: jest.fn().mockResolvedValue({
        removed: true,
        member: { email: 'awa@e.cg', role: 'RECRUITER' },
      }),
      disconnectMailbox: jest.fn().mockResolvedValue({ ok: true }),
      careersOf: jest
        .fn()
        .mockResolvedValue({ photos: ['a.jpg', 'b.jpg'], coverUrl: 'c.jpg' }),
      removePhoto: jest.fn().mockResolvedValue({}),
      removeCover: jest.fn().mockResolvedValue({}),
      setDistribution: jest.fn().mockResolvedValue({}),
    };
    logs = { create: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminBusinessController(service, logs as any);
  });

  it('reads the figures over a known period only', async () => {
    await controller.overview('p-1', '90');
    await controller.overview('p-1', '365');
    expect(service.overview.mock.calls).toEqual([
      ['p-1', 90],
      ['p-1', 30],
    ]);
  });

  it.each([
    [
      'resend',
      () => controller.resend('p-1', 'm-1', req),
      'BUSINESS_MEMBER_INVITE_RESENT',
      'm-1',
    ],
    [
      'removeMember',
      () => controller.removeMember('p-1', 'm-1', req),
      'BUSINESS_MEMBER_REMOVED',
      'm-1',
    ],
    [
      'disconnect',
      () => controller.disconnect('p-1', 'box-1', req),
      'BUSINESS_MAILBOX_DISCONNECTED',
      'box-1',
    ],
    [
      'removeCover',
      () => controller.removeCover('p-1', req),
      'BUSINESS_CAREERS_MEDIA_REMOVED',
      'p-1',
    ],
  ])('logs %s in the admin log', async (_name, act, action, entityId) => {
    await act();
    expect(logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action,
        entityId,
        userId: 'admin-1',
        profileId: 'p-1',
      }),
    );
  });

  it('records which photo it took down, and the distribution switch', async () => {
    await controller.removePhoto('p-1', 1, req);
    expect(logs.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { kind: 'photo', url: 'b.jpg' } }),
    );
    await controller.distribution('p-1', { distributeOffers: false }, req);
    expect(service.setDistribution).toHaveBeenCalledWith('p-1', false);
    expect(logs.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'BUSINESS_DISTRIBUTION_SET',
        metadata: { distributeOffers: false },
      }),
    );
  });
});
