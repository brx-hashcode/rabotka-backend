import {
  AccountStatus,
  ProfileNotificationType,
  ProfileType,
} from '@prisma/client';
import {
  ProfileNotificationService,
  profileViewBody,
} from '../profile-notification.service';
import {
  PROFILE_VIEWS_THRESHOLD_EVENT,
  profileViewDedupeKey,
  profileViewsReminderKey,
} from '../profile-notification.events';

const EMPLOYER_ID = 'e-1';
const WORKER_ID = 'w-1';

const activeWorker = {
  profile_type: ProfileType.WORKER,
  status: AccountStatus.ACTIVE,
  deleted_at: null,
};

const employer = {
  city: 'Brazzaville',
  category: { name: 'Restauration' },
  // Present on the row to prove it never reaches the copy.
  first_name: 'Hôtel',
  last_name: 'Olympic',
};

const createdRow = {
  id: 'n-1',
  type: ProfileNotificationType.PROFILE_VIEW,
  title: 'Votre profil a été consulté',
  body: 'x',
  link: '/profile',
  metadata: null,
  created_at: new Date('2026-09-16T10:00:00Z'),
  read_at: null,
  actor: { avatar_url: 'https://cdn.example/avatars/e-1.jpg' },
};

describe('ProfileNotificationService', () => {
  let service: ProfileNotificationService;
  let prisma: {
    profile: { findUnique: jest.Mock };
    profileNotification: {
      create: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      createMany?: jest.Mock;
    };
    broadcastRecipient: { updateMany: jest.Mock };
    broadcast: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let idempotency: { claim: jest.Mock; release: jest.Mock };
  let systemConfig: {
    getProfileViewsWhatsAppThreshold: jest.Mock;
    getProfileViewsWhatsAppCooldownHours: jest.Mock;
  };
  let gateway: { emitNew: jest.Mock };
  let events: { emit: jest.Mock };
  let push: { send: jest.Mock; sendMany: jest.Mock };

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(where.id === WORKER_ID ? activeWorker : employer),
          ),
      },
      profileNotification: {
        create: jest.fn().mockResolvedValue(createdRow),
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      broadcastRecipient: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      broadcast: {
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    idempotency = {
      claim: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    systemConfig = {
      getProfileViewsWhatsAppThreshold: jest.fn().mockResolvedValue(5),
      getProfileViewsWhatsAppCooldownHours: jest.fn().mockResolvedValue(168),
    };
    gateway = { emitNew: jest.fn() };
    events = { emit: jest.fn() };
    push = {
      send: jest.fn().mockResolvedValue(undefined),
      sendMany: jest.fn().mockResolvedValue(undefined),
    };

    service = new ProfileNotificationService(
      prisma as never,
      idempotency as never,
      systemConfig as never,
      gateway as never,
      events as never,
      push as never,
    );
  });

  describe('profileViewBody', () => {
    it('names the sector and city', () => {
      expect(profileViewBody('Restauration', 'Brazzaville')).toBe(
        'Un employeur du secteur Restauration à Brazzaville a consulté votre profil.',
      );
    });

    it('drops the parts the employer never filled in', () => {
      expect(profileViewBody(null, null)).toBe(
        'Un employeur a consulté votre profil.',
      );
      expect(profileViewBody(null, 'Pointe-Noire')).toBe(
        'Un employeur à Pointe-Noire a consulté votre profil.',
      );
    });
  });

  describe('notifyProfileView', () => {
    it('writes an anonymised notification and pushes it', async () => {
      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(idempotency.claim).toHaveBeenCalledWith(
        profileViewDedupeKey(EMPLOYER_ID, WORKER_ID),
        86400,
      );
      const { data } = prisma.profileNotification.create.mock.calls[0][0];
      expect(data).toMatchObject({
        recipient_id: WORKER_ID,
        type: ProfileNotificationType.PROFILE_VIEW,
        actor_id: EMPLOYER_ID,
        metadata: { sector: 'Restauration', city: 'Brazzaville' },
      });
      expect(data.body).not.toMatch(/Hôtel|Olympic/);
      expect(gateway.emitNew).toHaveBeenCalledWith(
        WORKER_ID,
        expect.not.objectContaining({ actorId: expect.anything() }),
      );
    });

    it('does nothing when the pair was already notified today', async () => {
      idempotency.claim.mockResolvedValue(false);

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(prisma.profileNotification.create).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['not a worker', { ...activeWorker, profile_type: ProfileType.EMPLOYER }],
      ['suspended', { ...activeWorker, status: AccountStatus.SUSPENDED }],
      ['deleted', { ...activeWorker, deleted_at: new Date() }],
    ])('skips a worker who is %s', async (_label, row) => {
      prisma.profile.findUnique.mockResolvedValue(row);

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(idempotency.claim).not.toHaveBeenCalled();
      expect(prisma.profileNotification.create).not.toHaveBeenCalled();
    });

    it('ignores a profile viewing itself', async () => {
      await service.notifyProfileView(WORKER_ID, WORKER_ID);
      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });

    it('hands the claim back when the insert fails, and never throws', async () => {
      prisma.profileNotification.create.mockRejectedValue(new Error('db'));

      await expect(
        service.notifyProfileView(EMPLOYER_ID, WORKER_ID),
      ).resolves.toBeUndefined();
      expect(idempotency.release).toHaveBeenCalledWith(
        profileViewDedupeKey(EMPLOYER_ID, WORKER_ID),
      );
    });

    it('keeps the claim when only the reminder step fails', async () => {
      systemConfig.getProfileViewsWhatsAppThreshold.mockRejectedValue(
        new Error('config'),
      );

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(prisma.profileNotification.create).toHaveBeenCalled();
      expect(idempotency.release).not.toHaveBeenCalled();
    });
  });

  describe('WhatsApp reminder', () => {
    it('stays quiet at the threshold', async () => {
      prisma.profileNotification.count.mockResolvedValue(5);

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('fires once the unread count passes the threshold', async () => {
      prisma.profileNotification.count.mockResolvedValue(6);

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(idempotency.claim).toHaveBeenLastCalledWith(
        profileViewsReminderKey(WORKER_ID),
        168 * 3600,
      );
      expect(events.emit).toHaveBeenCalledWith(PROFILE_VIEWS_THRESHOLD_EVENT, {
        workerId: WORKER_ID,
        unreadCount: 6,
      });
    });

    it('does not fire again inside the cooldown', async () => {
      prisma.profileNotification.count.mockResolvedValue(7);
      // Pair claim wins, reminder claim is already held.
      idempotency.claim
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(prisma.profileNotification.create).toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('is off when the threshold is 0', async () => {
      systemConfig.getProfileViewsWhatsAppThreshold.mockResolvedValue(0);
      prisma.profileNotification.count.mockResolvedValue(50);

      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('counts unread profile views only', async () => {
      await service.notifyProfileView(EMPLOYER_ID, WORKER_ID);

      expect(prisma.profileNotification.count).toHaveBeenCalledWith({
        where: {
          recipient_id: WORKER_ID,
          type: ProfileNotificationType.PROFILE_VIEW,
          read_at: null,
          dismissed_at: null,
        },
      });
    });
  });

  describe('handleEvent', () => {
    it('renders the copy from the catalog and stores the actor', async () => {
      await service.handleEvent({
        recipientId: 'emp-1',
        actorId: WORKER_ID,
        input: {
          type: 'NEW_APPLICATION',
          applicationId: 'app-1',
          jobTitle: 'Plombier',
          workerName: 'Awa K.',
        },
      });

      const { data } = prisma.profileNotification.create.mock.calls[0][0];
      expect(data).toMatchObject({
        recipient_id: 'emp-1',
        type: 'NEW_APPLICATION',
        title: 'Nouvelle candidature',
        link: '/candidatures/app-1',
        actor_id: WORKER_ID,
        metadata: {
          applicationId: 'app-1',
          jobTitle: 'Plombier',
          workerName: 'Awa K.',
        },
      });
      expect(data.body).toContain('Awa K.');
      expect(idempotency.claim).not.toHaveBeenCalled();
      expect(gateway.emitNew).toHaveBeenCalledWith('emp-1', expect.anything());
    });

    it('sends the same notification to the recipient’s phone', async () => {
      await service.handleEvent({
        recipientId: 'emp-1',
        input: {
          type: 'NEW_APPLICATION',
          applicationId: 'app-1',
          jobTitle: 'Plombier',
          workerName: 'Awa K.',
        },
      });

      expect(push.send).toHaveBeenCalledWith('emp-1', {
        id: createdRow.id,
        title: createdRow.title,
        body: createdRow.body,
        link: createdRow.link,
      });
    });

    const failed = {
      recipientId: WORKER_ID,
      dedupeKey: 'k',
      dedupeTtlSeconds: 60,
      input: {
        type: 'PAYMENT_FAILED' as const,
        amount: 1000,
        kind: 'WALLET_TOP_UP' as const,
      },
    };

    it('skips a deduplicated event', async () => {
      idempotency.claim.mockResolvedValue(false);

      await service.handleEvent(failed);

      expect(idempotency.claim).toHaveBeenCalledWith('k', 60);
      expect(prisma.profileNotification.create).not.toHaveBeenCalled();
    });

    it('releases the key and swallows the error when the insert fails', async () => {
      prisma.profileNotification.create.mockRejectedValue(new Error('db'));

      await expect(service.handleEvent(failed)).resolves.toBeUndefined();
      expect(idempotency.release).toHaveBeenCalledWith('k');
    });
  });

  describe('reading', () => {
    it('lists the recipient’s own rows, paginated, without the actor', async () => {
      prisma.profileNotification.findMany.mockResolvedValue([createdRow]);
      prisma.profileNotification.count.mockResolvedValue(21);

      const result = await service.list(WORKER_ID, 2, 10);

      const args = prisma.profileNotification.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        recipient_id: WORKER_ID,
        dismissed_at: null,
      });
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      // The actor is read for its photo only.
      expect(args.select.actor).toEqual({ select: { avatar_url: true } });
      expect(args.select).not.toHaveProperty('actor_id');
      expect(result).toMatchObject({ total: 21, page: 2, limit: 10 });
      expect(result.items[0]).toEqual({
        id: 'n-1',
        type: ProfileNotificationType.PROFILE_VIEW,
        title: createdRow.title,
        body: createdRow.body,
        link: '/profile',
        metadata: null,
        actorAvatarUrl: 'https://cdn.example/avatars/e-1.jpg',
        createdAt: createdRow.created_at,
        readAt: null,
      });
    });

    it('marks one read only when it belongs to the recipient', async () => {
      await service.markRead(WORKER_ID, 'n-1');

      expect(prisma.profileNotification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n-1', recipient_id: WORKER_ID, read_at: null },
        data: { read_at: expect.any(Date) },
      });
    });

    it('marks all of the recipient’s rows read', async () => {
      await service.markAllRead(WORKER_ID);

      expect(prisma.profileNotification.updateMany).toHaveBeenCalledWith({
        where: { recipient_id: WORKER_ID, read_at: null },
        data: { read_at: expect.any(Date) },
      });
    });

    it('counts only rows still in the feed as unread', async () => {
      await service.unreadCount(WORKER_ID);

      expect(prisma.profileNotification.count).toHaveBeenCalledWith({
        where: { recipient_id: WORKER_ID, read_at: null, dismissed_at: null },
      });
    });

    it('clears one row for its recipient, marking it read too', async () => {
      await service.dismiss(WORKER_ID, 'n-1');

      const [readCall, dismissCall] =
        prisma.profileNotification.updateMany.mock.calls;
      expect(readCall[0]).toEqual({
        where: {
          id: 'n-1',
          recipient_id: WORKER_ID,
          dismissed_at: null,
          read_at: null,
        },
        data: { read_at: expect.any(Date) },
      });
      expect(dismissCall[0]).toEqual({
        where: { id: 'n-1', recipient_id: WORKER_ID, dismissed_at: null },
        data: { dismissed_at: expect.any(Date) },
      });
    });

    it('clears every row of the recipient only', async () => {
      await service.dismissAll(WORKER_ID);

      for (const [args] of prisma.profileNotification.updateMany.mock.calls) {
        expect(args.where.recipient_id).toBe(WORKER_ID);
        expect(args.where).not.toHaveProperty('id');
      }
    });

    it('shows admins who caused each notification', async () => {
      prisma.profileNotification.findMany.mockResolvedValue([
        {
          ...createdRow,
          dismissed_at: null,
          actor: {
            avatar_url: null,
            id: EMPLOYER_ID,
            first_name: 'Hôtel',
            last_name: 'Olympic',
            profile_type: ProfileType.EMPLOYER,
          },
        },
      ]);
      prisma.profileNotification.count.mockResolvedValue(1);

      const result = await service.listForAdmin(WORKER_ID, 1, 20);

      expect(result.data[0].actor).toEqual({
        profileId: EMPLOYER_ID,
        firstName: 'Hôtel',
        lastName: 'Olympic',
        profileType: ProfileType.EMPLOYER,
      });
    });
  });

  describe('broadcast reads', () => {
    const BROADCAST_ID = 'b-1';

    const announcement = {
      type: 'ANNOUNCEMENT',
      metadata: { broadcastId: BROADCAST_ID, title: 'Maintenance' },
    };

    it('moves the delivery row to READ when the announcement is opened', async () => {
      prisma.profileNotification.findUnique.mockResolvedValue(announcement);

      await service.markRead(WORKER_ID, 'n-1');

      // Only from SENT: a row opened twice must not be counted twice.
      expect(prisma.broadcastRecipient.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            broadcast_id: BROADCAST_ID,
            profile_id: WORKER_ID,
            status: 'SENT',
          }),
          data: { status: 'READ' },
        }),
      );
      expect(prisma.broadcast.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BROADCAST_ID },
          data: { read_count: { increment: 1 } },
        }),
      );
    });

    it('does not touch a broadcast for an ordinary notification', async () => {
      prisma.profileNotification.findUnique.mockResolvedValue({
        type: 'JOB_RECOMMENDATION',
        metadata: { jobOfferId: 'jo-1' },
      });

      await service.markRead(WORKER_ID, 'n-1');

      expect(prisma.broadcastRecipient.updateMany).not.toHaveBeenCalled();
    });

    it('counts nothing when the row was already read', async () => {
      prisma.profileNotification.updateMany.mockResolvedValue({ count: 0 });

      await service.markRead(WORKER_ID, 'n-1');

      // The read already happened; re-opening must not inflate the counter.
      expect(prisma.profileNotification.findUnique).not.toHaveBeenCalled();
      expect(prisma.broadcast.update).not.toHaveBeenCalled();
    });

    it('attributes every unread announcement on mark-all-read', async () => {
      prisma.profileNotification.findMany.mockResolvedValue([
        { metadata: { broadcastId: BROADCAST_ID } },
        { metadata: { broadcastId: 'b-2' } },
        // No broadcast id — a row written before the field existed.
        { metadata: { title: 'x' } },
      ]);

      await service.markAllRead(WORKER_ID);

      expect(prisma.broadcast.update).toHaveBeenCalledTimes(2);
    });

    it('still marks the notification read when the attribution fails', async () => {
      prisma.profileNotification.findUnique.mockResolvedValue(announcement);
      prisma.broadcastRecipient.updateMany.mockRejectedValue(
        new Error('db down'),
      );

      // The row IS read — a reporting counter must not be able to undo that.
      await expect(service.markRead(WORKER_ID, 'n-1')).resolves.toBeUndefined();
      expect(prisma.profileNotification.updateMany).toHaveBeenCalled();
    });
  });
  describe('createMany', () => {
    it('pushes each written row to its recipient', async () => {
      prisma.profileNotification.createMany = jest
        .fn()
        .mockResolvedValue({ count: 2 });
      prisma.profileNotification.findMany.mockResolvedValue([
        { ...createdRow, id: 'n-a', recipient_id: 'p-a' },
        { ...createdRow, id: 'n-b', recipient_id: 'p-b' },
      ]);

      await service.createMany(['p-a', 'p-b'], {
        type: 'ANNOUNCEMENT',
        broadcastId: 'b-1',
        title: 'Nouveauté',
        body: 'Texte',
        link: null,
      });

      expect(push.sendMany).toHaveBeenCalledWith([
        { profileId: 'p-a', payload: expect.objectContaining({ id: 'n-a' }) },
        { profileId: 'p-b', payload: expect.objectContaining({ id: 'n-b' }) },
      ]);
    });
  });
});
