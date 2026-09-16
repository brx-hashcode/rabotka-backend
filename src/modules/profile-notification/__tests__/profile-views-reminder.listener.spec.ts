import { AccountStatus, ProfileType } from '@prisma/client';
import { ProfileViewsReminderListener } from '../profile-views-reminder.listener';
import { profileViewsReminderKey } from '../profile-notification.events';

const WORKER_ID = 'w-1';

const worker = {
  phone: '+242060000000',
  first_name: 'Awa',
  status: AccountStatus.ACTIVE,
  profile_type: ProfileType.WORKER,
  deleted_at: null,
};

describe('ProfileViewsReminderListener', () => {
  let listener: ProfileViewsReminderListener;
  let prisma: { profile: { findUnique: jest.Mock } };
  let idempotency: { release: jest.Mock };
  let whatsApp: { sendTemplateMessage: jest.Mock };
  let loginLink: { mint: jest.Mock };

  beforeEach(() => {
    prisma = { profile: { findUnique: jest.fn().mockResolvedValue(worker) } };
    idempotency = { release: jest.fn().mockResolvedValue(undefined) };
    whatsApp = { sendTemplateMessage: jest.fn().mockResolvedValue(true) };
    loginLink = { mint: jest.fn().mockResolvedValue('code-123') };
    listener = new ProfileViewsReminderListener(
      prisma as never,
      idempotency as never,
      whatsApp as never,
      loginLink as never,
    );
  });

  it('sends the digest template with a login code into the feed', async () => {
    await listener.handle({ workerId: WORKER_ID, unreadCount: 6 });

    expect(loginLink.mint).toHaveBeenCalledWith(WORKER_ID, 'notifications');
    expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      worker.phone,
      'profileViewsDigest',
      { firstName: 'Awa', count: 6, loginCode: 'code-123' },
      WORKER_ID,
    );
    expect(idempotency.release).not.toHaveBeenCalled();
  });

  it('still sends when no code could be minted', async () => {
    loginLink.mint.mockRejectedValue(new Error('redis'));

    await listener.handle({ workerId: WORKER_ID, unreadCount: 6 });

    expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      worker.phone,
      'profileViewsDigest',
      expect.objectContaining({ loginCode: null }),
      WORKER_ID,
    );
  });

  it.each([
    ['inactive', { ...worker, status: AccountStatus.SUSPENDED }],
    ['phoneless', { ...worker, phone: '  ' }],
    ['gone', null],
  ])('releases the cooldown for a %s worker', async (_label, row) => {
    prisma.profile.findUnique.mockResolvedValue(row);

    await listener.handle({ workerId: WORKER_ID, unreadCount: 6 });

    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(idempotency.release).toHaveBeenCalledWith(
      profileViewsReminderKey(WORKER_ID),
    );
  });

  it('releases the cooldown when the provider sends nothing', async () => {
    whatsApp.sendTemplateMessage.mockResolvedValue(false);

    await listener.handle({ workerId: WORKER_ID, unreadCount: 6 });

    expect(idempotency.release).toHaveBeenCalled();
  });

  it('releases the cooldown and swallows a throw', async () => {
    whatsApp.sendTemplateMessage.mockRejectedValue(new Error('132001'));

    await expect(
      listener.handle({ workerId: WORKER_ID, unreadCount: 6 }),
    ).resolves.toBeUndefined();
    expect(idempotency.release).toHaveBeenCalled();
  });
});
