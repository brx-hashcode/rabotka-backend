import { ConfigService } from '@nestjs/config';
import { KycReviewerListener } from '../kyc-reviewer.listener';
import { AdminNotificationEvent } from '../../../common/events/admin-notification.events';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { NotificationService } from '../../notification/notification.service';

const PROFILE_ID = 'profile-1';

const payload = {
  event: AdminNotificationEvent.PROFILE_CREATED,
  title: 'Nouveau profil',
  message: 'Nouveau profil créé : Awa Mboko',
  entityType: 'profile' as const,
  entityId: PROFILE_ID,
  timestamp: new Date().toISOString(),
};

function setup(opts: {
  profile?: unknown;
  reviewers?: { email: string; first_name: string }[];
  notify?: jest.Mock;
}) {
  const prisma = {
    profile: {
      findUnique: jest.fn().mockResolvedValue(
        'profile' in opts
          ? opts.profile
          : {
              first_name: 'Awa',
              last_name: 'Mboko',
              profile_type: 'WORKER',
              city: 'Brazzaville',
            },
      ),
    },
    user: { findMany: jest.fn().mockResolvedValue(opts.reviewers ?? []) },
  };
  const notify = opts.notify ?? jest.fn().mockResolvedValue(undefined);
  const notification = { notifyKycReviewRequested: notify };
  const config = {
    get: jest.fn().mockReturnValue('https://admin.rabotka.work/'),
  };
  const listener = new KycReviewerListener(
    prisma as unknown as PrismaService,
    notification as unknown as NotificationService,
    config as unknown as ConfigService,
  );
  return { listener, prisma, notify };
}

describe('KycReviewerListener', () => {
  it('emails every member of the group with a link to the profile', async () => {
    const { listener, notify } = setup({
      reviewers: [
        { email: 'a@rabotka.work', first_name: 'Alice' },
        { email: 'b@rabotka.work', first_name: 'Bruno' },
      ],
    });

    await listener.onProfileCreated(payload);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('a@rabotka.work', {
      reviewerFirstName: 'Alice',
      profileName: 'Awa Mboko',
      profileType: 'WORKER',
      city: 'Brazzaville',
      reviewUrl: `https://admin.rabotka.work/profiles/${PROFILE_ID}`,
    });
  });

  it('asks only for active, non-archived group members', async () => {
    const { listener, prisma } = setup({});

    await listener.onProfileCreated(payload);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kyc_reviewer: true, is_active: true, deleted_at: null },
      }),
    );
  });

  it('sends nothing when the group is empty', async () => {
    const { listener, notify } = setup({ reviewers: [] });

    await listener.onProfileCreated(payload);

    expect(notify).not.toHaveBeenCalled();
  });

  it('sends nothing when the profile is gone', async () => {
    const { listener, notify } = setup({
      profile: null,
      reviewers: [{ email: 'a@rabotka.work', first_name: 'Alice' }],
    });

    await listener.onProfileCreated(payload);

    expect(notify).not.toHaveBeenCalled();
  });

  it('still emails the others when one send fails, and never throws', async () => {
    const notify = jest
      .fn()
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce(undefined);
    const { listener } = setup({
      notify,
      reviewers: [
        { email: 'a@rabotka.work', first_name: 'Alice' },
        { email: 'b@rabotka.work', first_name: 'Bruno' },
      ],
    });

    await expect(listener.onProfileCreated(payload)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('never throws when the lookup fails', async () => {
    const { listener, prisma } = setup({});
    prisma.user.findMany.mockRejectedValue(new Error('db down'));

    await expect(listener.onProfileCreated(payload)).resolves.toBeUndefined();
  });
});
