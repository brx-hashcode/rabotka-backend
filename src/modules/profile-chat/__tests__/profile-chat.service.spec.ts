import {
  AccountStatus,
  ApplicationStatus,
  ContactUnlockStatus,
  MessageModerationStatus,
  Prisma,
  ProfileType,
} from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProfileChatService } from '../profile-chat.service';
import { PROFILE_NOTIFICATION_EVENT } from '../../profile-notification/profile-notification.events';
import { ModerationService } from '../moderation/moderation.service';
import { AdminNotificationEvent } from '../../../common/events/admin-notification.events';

const WORKER = 'w-1';
const EMPLOYER = 'e-1';
const STRANGER = 's-1';
const CONV = 'c-1';
const APP = 'a-1';

const conversation = {
  id: CONV,
  worker_id: WORKER,
  employer_id: EMPLOYER,
  application_id: APP,
  closed_at: null,
  last_message_at: null,
  worker_last_read_at: null,
  employer_last_read_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

/** "appelle moi au 06 12 34 56 78" — the digits start at 15 and run to 29. */
const BODY_WITH_PHONE = 'appelle moi au 06 12 34 56 78';
const PHONE_SPAN = { start_offset: 15, end_offset: 29, category: 'PHONE' };

describe('ProfileChatService', () => {
  let service: ProfileChatService;
  let prisma: any;
  let config: { get: jest.Mock };
  let gateway: {
    emitMessage: jest.Mock;
    emitRead: jest.Mock;
    emitDeleted: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let queue: { addJob: jest.Mock };
  let presence: { onlineAmong: jest.Mock };

  const storedMessage = (over: Record<string, unknown> = {}) => ({
    id: 'm-1',
    conversation_id: CONV,
    sender_id: WORKER,
    body: BODY_WITH_PHONE,
    moderation_status: MessageModerationStatus.REDACTED,
    created_at: new Date('2026-09-21T10:00:00Z'),
    read_at: null,
    redactions: [PHONE_SPAN],
    ...over,
  });

  beforeEach(() => {
    prisma = {
      application: {
        findFirst: jest.fn(),
        findUnique: jest
          .fn()
          .mockResolvedValue({ job_offer: { title: 'Ménage bureau' } }),
      },
      profileConversation: {
        fields: { worker_hidden_at: 'w', employer_hidden_at: 'e' },
        findUnique: jest.fn().mockResolvedValue(conversation),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(conversation),
      },
      profileMessage: {
        create: jest.fn().mockResolvedValue(storedMessage()),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      contactUnlockAttempt: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Sara', last_name: 'Colombe' }),
        findMany: jest.fn().mockResolvedValue([
          { id: WORKER, first_name: 'Sara', last_name: 'Colombe' },
          { id: EMPLOYER, first_name: 'Paul', last_name: 'Mabiala' },
        ]),
      },
      redactionReport: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    config = {
      get: jest.fn().mockImplementation((key: string, fallback: string) => {
        if (key === 'messaging.enabled') return Promise.resolve('true');
        if (key === 'messaging.moderate_after_unlock')
          return Promise.resolve('false');
        if (key === 'messaging.operator_prefixes') return Promise.resolve('');
        if (key === 'messaging.held_ratio_threshold')
          return Promise.resolve('0.5');
        return Promise.resolve(fallback);
      }),
    };

    gateway = {
      emitMessage: jest.fn(),
      emitRead: jest.fn(),
      emitDeleted: jest.fn(),
    };
    events = { emit: jest.fn() };
    queue = { addJob: jest.fn().mockResolvedValue('job-1') };
    presence = { onlineAmong: jest.fn().mockResolvedValue(new Set()) };

    service = new ProfileChatService(
      prisma,
      config as never,
      new ModerationService(config as never),
      gateway as never,
      events as never,
      queue as never,
      presence as never,
    );
  });

  /**
   * THE TESTS THAT DECIDE WHETHER THE FEATURE IS REAL.
   *
   * Everything else here is plumbing. If the recipient's payload carries the
   * digits, redacting them in the client is decoration and a network tab
   * defeats the whole product.
   */
  describe('one conversation, for the thread header', () => {
    it('describes a thread nobody has written in yet', async () => {
      // The list leaves such a thread out, and the header used to look its
      // counterpart up there — so a fresh thread showed "Discussion".
      prisma.profileConversation.findUniqueOrThrow = jest
        .fn()
        .mockResolvedValue({
          ...conversation,
          last_message_at: null,
          worker: {
            id: WORKER,
            first_name: 'Sara',
            last_name: 'Colombe',
            avatar_url: null,
          },
          employer: {
            id: EMPLOYER,
            first_name: 'Job',
            last_name: 'ITOUA',
            avatar_url: null,
          },
          application: { id: APP, job_offer: { title: 'Ménage bureau' } },
          messages: [],
        });

      const view = await service.getConversation(CONV, EMPLOYER);

      expect(view.counterpartName).toBe('Sara Colombe');
      expect(view.jobTitle).toBe('Ménage bureau');
      expect(view.lastMessagePreview).toBeNull();
    });

    it('refuses a third party', async () => {
      await expect(service.getConversation(CONV, STRANGER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('the two views of one message', () => {
    it('gives the author their own text back, with the offsets', async () => {
      const message = await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);

      expect(message.body).toBe(BODY_WITH_PHONE);
      expect(message.mine).toBe(true);
      expect(message.redactions).toEqual([
        { start: 15, end: 29, category: 'PHONE' },
      ]);
      // The offsets must cut the real fragment out of the real body.
      expect(message.body.slice(15, 29)).toBe('06 12 34 56 78');
    });

    it('never sends the digits to the recipient', async () => {
      prisma.profileMessage.findMany.mockResolvedValue([storedMessage()]);
      prisma.profileMessage.count.mockResolvedValue(1);

      const { data } = await service.listMessages(CONV, EMPLOYER);

      expect(data[0].body).not.toMatch(/\d/);
      expect(data[0].body).toContain('[masqué]');
    });

    it('never sends the OFFSETS to the recipient either', async () => {
      // Positions would tell the recipient exactly where to ask "what did you
      // write there?", which is the one move this feature exists to stop.
      prisma.profileMessage.findMany.mockResolvedValue([storedMessage()]);
      prisma.profileMessage.count.mockResolvedValue(1);

      const { data } = await service.listMessages(CONV, EMPLOYER);

      expect(data[0].redactions).toEqual([]);
      expect(data[0].mine).toBe(false);
    });

    it('leaves a clean message untouched for both sides', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          body: 'je suis disponible lundi',
          moderation_status: MessageModerationStatus.CLEAN,
          redactions: [],
        }),
      );

      const message = await service.sendMessage(
        CONV,
        WORKER,
        'je suis disponible lundi',
      );

      expect(message.status).toBe(MessageModerationStatus.CLEAN);
      expect(message.redactions).toEqual([]);
    });

    it('rebuilds the recipient view from the STORED offsets, not by re-detecting', async () => {
      // Patterns will change. A message must read the same tomorrow as it did
      // when it was sent, so the stored span wins even when it disagrees with
      // what the detector would say today.
      prisma.profileMessage.findMany.mockResolvedValue([
        storedMessage({
          body: 'mon chiffre porte-bonheur est 7',
          redactions: [{ start_offset: 30, end_offset: 31, category: 'PHONE' }],
        }),
      ]);
      prisma.profileMessage.count.mockResolvedValue(1);

      const { data } = await service.listMessages(CONV, EMPLOYER);

      expect(data[0].body).toBe('mon chiffre porte-bonheur est [masqué]');
    });
  });

  describe('reaching the recipient', () => {
    const notificationOf = () =>
      events.emit.mock.calls.find(
        ([name]) => name === PROFILE_NOTIFICATION_EVENT,
      )?.[1];

    it('pushes the RECIPIENT view, never the author one', async () => {
      // The socket bypasses the HTTP response entirely, so if this pushed the
      // author's view the withheld characters would go straight down the wire
      // and undo everything the controller did.
      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);

      const [to, pushed] = gateway.emitMessage.mock.calls[0];
      expect(to).toBe(EMPLOYER);
      expect(pushed.body).not.toMatch(/\d/);
      expect(pushed.redactions).toEqual([]);
      expect(pushed.mine).toBe(false);
    });

    it('raises the in-app bell for the recipient', async () => {
      await service.sendMessage(CONV, WORKER, 'bonjour, je suis disponible');

      const payload = notificationOf();
      expect(payload.recipientId).toBe(EMPLOYER);
      expect(payload.actorId).toBe(WORKER);
      expect(payload.input.type).toBe('NEW_MESSAGE');
      expect(payload.input.conversationId).toBe(CONV);
      expect(payload.input.senderName).toBe('Sara Colombe');
    });

    it('collapses a burst into one bell entry, by conversation and recipient', async () => {
      // A chat produces dozens of events an hour. One feed row each would bury
      // every other notification a person has, so the dedupe key is the whole
      // reason this type is safe to add at all.
      await service.sendMessage(CONV, WORKER, 'bonjour');
      await service.sendMessage(CONV, WORKER, 'vous etes la ?');

      const keys = events.emit.mock.calls
        .filter(([name]) => name === PROFILE_NOTIFICATION_EVENT)
        .map(([, payload]) => payload.dedupeKey);

      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toContain(CONV);
      expect(keys[0]).toContain(EMPLOYER);
      expect(notificationOf().dedupeTtlSeconds).toBeGreaterThan(0);
    });

    it('puts no message text in the notification', async () => {
      // Feed rows are rendered at write time and stored, so any text copied in
      // would outlive a later correction to what should have been withheld.
      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);

      const serialised = JSON.stringify(notificationOf());
      expect(serialised).not.toContain('06 12 34 56 78');
      expect(serialised).not.toContain('appelle');
    });

    it('queues a delayed nudge for the recipient', async () => {
      await service.sendMessage(CONV, WORKER, 'bonjour');

      const [, data, options] = queue.addJob.mock.calls[0];
      expect(data).toEqual({ conversationId: CONV, recipientId: EMPLOYER });
      expect(options.delay).toBeGreaterThan(0);
      expect(options.jobId).toContain(CONV);
      expect(options.jobId).toContain(EMPLOYER);
    });

    it('does not fail the send when the queue is down', async () => {
      // The message is already stored and already pushed. Losing the nudge is
      // a smaller harm than a 500 on a message that actually went through.
      queue.addJob.mockRejectedValue(new Error('redis down'));
      await expect(
        service.sendMessage(CONV, WORKER, 'bonjour'),
      ).resolves.toBeTruthy();
    });

    it('neither pushes nor notifies for a held message', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          moderation_status: MessageModerationStatus.HELD,
          redactions: [{ start_offset: 0, end_offset: 10, category: 'PHONE' }],
        }),
      );

      await service.sendMessage(CONV, WORKER, '0612345678');

      expect(gateway.emitMessage).not.toHaveBeenCalled();
      expect(notificationOf()).toBeUndefined();
      expect(queue.addJob).not.toHaveBeenCalled();
    });

    it('notifies the worker when the employer writes', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({ sender_id: EMPLOYER }),
      );
      await service.sendMessage(CONV, EMPLOYER, 'bonjour');

      expect(gateway.emitMessage.mock.calls[0][0]).toBe(WORKER);
      expect(notificationOf().recipientId).toBe(WORKER);
    });
  });

  describe('holding a message back', () => {
    const heldAlert = () =>
      events.emit.mock.calls.find(
        ([name]) => name === AdminNotificationEvent.CONVERSATION_MESSAGE_HELD,
      )?.[1];
    /** The alert is emitted after a lookup the send does not wait for. */
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('alerts the admins, naming both sides and linking the conversation', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          body: '0612345678',
          moderation_status: MessageModerationStatus.HELD,
          redactions: [{ start_offset: 0, end_offset: 10, category: 'PHONE' }],
        }),
      );

      await service.sendMessage(CONV, WORKER, '0612345678');
      await flush();

      const alert = heldAlert();
      expect(alert).toMatchObject({
        event: AdminNotificationEvent.CONVERSATION_MESSAGE_HELD,
        entityType: 'conversation',
        entityId: CONV,
        dedupeWindowMs: 60 * 60 * 1000,
        metadata: expect.objectContaining({
          conversationId: CONV,
          messageId: 'm-1',
          senderId: WORKER,
          recipientId: EMPLOYER,
          categories: ['PHONE'],
        }),
      });
      expect(alert.message).toContain('Sara Colombe → Paul Mabiala');
    });

    // The admin list carries no message text on purpose; reading a thread is
    // a separate, logged step. An alert must not become the way around that.
    it('never puts the held text in the alert', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          body: '0612345678',
          moderation_status: MessageModerationStatus.HELD,
          redactions: [{ start_offset: 0, end_offset: 10, category: 'PHONE' }],
        }),
      );

      await service.sendMessage(CONV, WORKER, '0612345678');
      await flush();

      expect(JSON.stringify(heldAlert())).not.toContain('0612345678');
    });

    it('does not alert for a delivered message, masked or clean', async () => {
      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);
      await service.sendMessage(CONV, WORKER, 'bonjour');
      await flush();

      expect(heldAlert()).toBeUndefined();
    });

    it('still returns the message when the alert lookup fails', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          moderation_status: MessageModerationStatus.HELD,
          redactions: [{ start_offset: 0, end_offset: 10, category: 'PHONE' }],
        }),
      );
      prisma.profile.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.sendMessage(CONV, WORKER, '0612345678'),
      ).resolves.toMatchObject({ status: MessageModerationStatus.HELD });
      await flush();
    });

    it('holds one that is mostly contact details, and delivers nothing', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          body: '0612345678',
          moderation_status: MessageModerationStatus.HELD,
          redactions: [{ start_offset: 0, end_offset: 10, category: 'PHONE' }],
        }),
      );

      const message = await service.sendMessage(CONV, WORKER, '0612345678');

      expect(message.status).toBe(MessageModerationStatus.HELD);
      expect(service.deliverableFor(message, EMPLOYER)).toBeNull();
    });

    it('does not bump the thread for a held message', async () => {
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          moderation_status: MessageModerationStatus.HELD,
          redactions: [{ start_offset: 0, end_offset: 10, category: 'PHONE' }],
        }),
      );

      await service.sendMessage(CONV, WORKER, '0612345678');

      // Otherwise the recipient's list lights up for something they cannot read.
      expect(prisma.profileConversation.update).not.toHaveBeenCalled();
    });

    it('bumps the thread for a delivered one', async () => {
      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);
      expect(prisma.profileConversation.update).toHaveBeenCalled();
    });

    it('hides a held message from the recipient but not from its author', async () => {
      await service.listMessages(CONV, EMPLOYER);
      const where = prisma.profileMessage.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { sender_id: EMPLOYER },
        { moderation_status: { not: MessageModerationStatus.HELD } },
      ]);
    });
  });

  describe('membership', () => {
    it.each([
      ['listMessages', () => service.listMessages(CONV, STRANGER)],
      ['sendMessage', () => service.sendMessage(CONV, STRANGER, 'salut')],
      ['markRead', () => service.markRead(CONV, STRANGER)],
    ])('refuses %s to a third party', async (_label, call) => {
      await expect(call()).rejects.toThrow(NotFoundException);
    });

    it('answers NotFound rather than Forbidden to a third party', async () => {
      // "It exists but is not yours" tells a prober that a given pair is
      // talking, which is information in itself.
      await expect(service.listMessages(CONV, STRANGER)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.listMessages(CONV, STRANGER)).rejects.not.toThrow(
        ForbiddenException,
      );
    });

    it('refuses to write to a closed conversation', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue({
        ...conversation,
        closed_at: new Date(),
      });
      await expect(service.sendMessage(CONV, WORKER, 'salut')).rejects.toThrow(
        /close/i,
      );
    });
  });

  describe('opening a conversation', () => {
    const application = {
      id: APP,
      worker_id: WORKER,
      status: ApplicationStatus.PENDING,
      job_offer: { employer_id: EMPLOYER },
    };

    beforeEach(() => {
      prisma.application.findFirst.mockResolvedValue(application);
      prisma.profileConversation.findUnique.mockResolvedValue(null);
      prisma.profileConversation.create.mockResolvedValue(conversation);
    });

    it('creates one on first use', async () => {
      await service.openForApplication(APP, WORKER);
      expect(prisma.profileConversation.create).toHaveBeenCalled();
    });

    it('returns the existing one rather than creating a second', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue(conversation);
      await service.openForApplication(APP, EMPLOYER);
      expect(prisma.profileConversation.create).not.toHaveBeenCalled();
    });

    it('survives two simultaneous first messages', async () => {
      // The loser of the race must re-read, not 500. This is the whole
      // concurrency story for lazy creation: no lock, one unique index.
      prisma.profileConversation.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.profileConversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(conversation);

      await expect(service.openForApplication(APP, WORKER)).resolves.toEqual(
        conversation,
      );
    });

    it('does not swallow a failure that is not the race', async () => {
      prisma.profileConversation.create.mockRejectedValue(
        new Error('disque plein'),
      );
      await expect(service.openForApplication(APP, WORKER)).rejects.toThrow(
        'disque plein',
      );
    });

    it('refuses somebody the application has nothing to do with', async () => {
      await expect(service.openForApplication(APP, STRANGER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses a dead application', async () => {
      prisma.application.findFirst.mockResolvedValue({
        ...application,
        status: ApplicationStatus.REJECTED,
      });
      await expect(service.openForApplication(APP, WORKER)).rejects.toThrow(
        /terminée/i,
      );
    });

    it('allows one waiting for payment — that is exactly when they need to talk', async () => {
      prisma.application.findFirst.mockResolvedValue({
        ...application,
        status: ApplicationStatus.WAITING_PAYMENT,
      });
      await expect(
        service.openForApplication(APP, WORKER),
      ).resolves.toBeTruthy();
    });
  });

  describe('opening a conversation with no application', () => {
    const employer = {
      id: EMPLOYER,
      profile_type: ProfileType.EMPLOYER,
      status: AccountStatus.ACTIVE,
    };
    const worker = {
      id: WORKER,
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
    };

    beforeEach(() => {
      prisma.profile.findFirst = jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === WORKER ? worker : employer),
        );
      prisma.profileConversation.findUnique.mockResolvedValue(null);
      prisma.profileConversation.count.mockResolvedValue(0);
      prisma.profileConversation.create.mockResolvedValue({
        ...conversation,
        application_id: null,
      });
    });

    it('creates one between an employer and a recommended worker', async () => {
      await service.openWithProfile(WORKER, EMPLOYER);

      expect(prisma.profileConversation.create.mock.calls[0][0].data).toEqual({
        worker_id: WORKER,
        employer_id: EMPLOYER,
        application_id: null,
      });
    });

    it('puts each party on the right side, whoever starts it', async () => {
      await service.openWithProfile(EMPLOYER, WORKER);
      expect(prisma.profileConversation.create.mock.calls[0][0].data).toEqual({
        worker_id: WORKER,
        employer_id: EMPLOYER,
        application_id: null,
      });
    });

    it('returns the existing one rather than a second', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue(conversation);
      await service.openWithProfile(WORKER, EMPLOYER);
      expect(prisma.profileConversation.create).not.toHaveBeenCalled();
    });

    it('survives a double tap', async () => {
      // The partial unique index caught it; re-read rather than 500.
      prisma.profileConversation.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.profileConversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(conversation);

      await expect(service.openWithProfile(WORKER, EMPLOYER)).resolves.toEqual(
        conversation,
      );
    });

    it('refuses two profiles of the same type', async () => {
      prisma.profile.findFirst = jest.fn().mockResolvedValue(employer);
      await expect(service.openWithProfile('e-2', EMPLOYER)).rejects.toThrow(
        /employeur et un travailleur/i,
      );
    });

    it('refuses writing to yourself', async () => {
      await expect(service.openWithProfile(WORKER, WORKER)).rejects.toThrow(
        /vous-même/i,
      );
    });

    it('answers NotFound for a suspended profile, same as for a missing one', async () => {
      // Otherwise this endpoint tells anybody who asks whether a given account
      // is suspended.
      prisma.profile.findFirst = jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === WORKER
              ? { ...worker, status: AccountStatus.SUSPENDED }
              : employer,
          ),
        );
      await expect(service.openWithProfile(WORKER, EMPLOYER)).rejects.toThrow(
        /introuvable/i,
      );
    });

    describe('the daily cap', () => {
      it('refuses once the cap is reached', async () => {
        // The only thing between "talk before you pay" and a mailing list.
        prisma.profileConversation.count.mockResolvedValue(20);
        await expect(service.openWithProfile(WORKER, EMPLOYER)).rejects.toThrow(
          /trop de discussions/i,
        );
      });

      it('counts only threads with no application behind them', async () => {
        // The application path carries the worker's own consent, so it needs
        // no ceiling — counting it would punish somebody for being popular.
        await service.openWithProfile(WORKER, EMPLOYER);
        expect(
          prisma.profileConversation.count.mock.calls[0][0].where,
        ).toMatchObject({ application_id: null });
      });

      it('does not count re-opening a thread that already exists', async () => {
        // Returning to a conversation is not reaching out to anybody new.
        prisma.profileConversation.findUnique.mockResolvedValue(conversation);
        await service.openWithProfile(WORKER, EMPLOYER);
        expect(prisma.profileConversation.count).not.toHaveBeenCalled();
      });

      it('treats a cap of 0 as no cap', async () => {
        config.get.mockImplementation((key: string, fallback: string) =>
          Promise.resolve(
            key === 'messaging.max_new_conversations_per_day' ? '0' : fallback,
          ),
        );
        prisma.profileConversation.count.mockResolvedValue(9999);
        await expect(
          service.openWithProfile(WORKER, EMPLOYER),
        ).resolves.toBeTruthy();
      });
    });
  });

  describe('one thread per person', () => {
    // The first version keyed threads on the application, and the same person
    // showed up once per application plus once for a direct message.
    const application = {
      id: 'a-2',
      worker_id: WORKER,
      status: ApplicationStatus.PENDING,
      job_offer: { employer_id: EMPLOYER },
    };

    beforeEach(() => {
      prisma.application.findFirst.mockResolvedValue(application);
    });

    it('looks the thread up by the PAIR, not by the application', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue(null);
      prisma.profileConversation.create.mockResolvedValue(conversation);
      await service.openForApplication('a-2', EMPLOYER);

      expect(
        prisma.profileConversation.findUnique.mock.calls[0][0].where,
      ).toEqual({
        worker_id_employer_id: { worker_id: WORKER, employer_id: EMPLOYER },
      });
    });

    it('reuses a direct thread when the same worker later applies', async () => {
      // An employer wrote to a recommended worker, who then applied: that is
      // one conversation, now about that application.
      prisma.profileConversation.findUnique.mockResolvedValue({
        ...conversation,
        application_id: null,
      });
      prisma.profileConversation.update.mockResolvedValue(conversation);

      await service.openForApplication('a-2', EMPLOYER);

      expect(prisma.profileConversation.create).not.toHaveBeenCalled();
      expect(prisma.profileConversation.update.mock.calls[0][0].data).toEqual({
        application_id: 'a-2',
      });
    });

    it('reuses an application thread when opened from the profile', async () => {
      prisma.profile.findFirst = jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            profile_type:
              where.id === WORKER ? ProfileType.WORKER : ProfileType.EMPLOYER,
            status: AccountStatus.ACTIVE,
          }),
        );
      prisma.profileConversation.findUnique.mockResolvedValue(conversation);

      await expect(service.openWithProfile(WORKER, EMPLOYER)).resolves.toEqual(
        conversation,
      );
      expect(prisma.profileConversation.create).not.toHaveBeenCalled();
    });

    it('keeps the thread open when one of the applications dies', async () => {
      // The pair may be talking about another one. A dead application only
      // stops being offered as the new context.
      prisma.application.findFirst.mockResolvedValue({
        ...application,
        status: ApplicationStatus.REJECTED,
      });
      prisma.profileConversation.findUnique.mockResolvedValue(conversation);

      await expect(
        service.openForApplication('a-2', EMPLOYER),
      ).resolves.toEqual(conversation);
      expect(prisma.profileConversation.update).not.toHaveBeenCalled();
    });

    it('lists only threads somebody has written in', async () => {
      // Opening creates the thread; backing out without writing must not leave
      // an empty row in the list.
      await service.listConversations(EMPLOYER);
      expect(
        prisma.profileConversation.findMany.mock.calls[0][0].where
          .last_message_at,
      ).toEqual({ not: null });
    });
  });

  describe('moderation has no exception', () => {
    it('still masks a number between a pair that has already unlocked', async () => {
      // This used to pass through: a pair who had paid for each other's
      // details could speak freely. The product ruled otherwise — contact
      // details never travel through a conversation, whatever was paid.
      prisma.contactUnlockAttempt.findFirst.mockResolvedValue({
        status: ContactUnlockStatus.UNLOCKED,
      });

      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);

      expect(
        prisma.profileMessage.create.mock.calls[0][0].data.redactions.create,
      ).toHaveLength(1);
    });

    it('never asks whether the pair has unlocked', async () => {
      // One query per message saved, and no way for the rule to drift.
      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);
      expect(prisma.contactUnlockAttempt.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('reading', () => {
    it('does not count the reader’s own messages as unread', async () => {
      await service.markRead(CONV, EMPLOYER);
      expect(
        prisma.profileMessage.updateMany.mock.calls[0][0].where,
      ).toMatchObject({ sender_id: { not: EMPLOYER } });
    });

    it('tells the author their messages were read', async () => {
      await service.markRead(CONV, EMPLOYER);
      expect(gateway.emitRead).toHaveBeenCalledWith(WORKER, CONV);
    });

    it('says nothing when there was nothing new to read', async () => {
      prisma.profileMessage.updateMany.mockResolvedValue({ count: 0 });
      await service.markRead(CONV, EMPLOYER);
      expect(gateway.emitRead).not.toHaveBeenCalled();
    });

    it('stamps the right side of the conversation', async () => {
      await service.markRead(CONV, WORKER);
      expect(
        prisma.profileConversation.update.mock.calls[0][0].data,
      ).toHaveProperty('worker_last_read_at');
    });
  });

  describe('deleting a conversation, for one side', () => {
    it('hides it for the side that asked, and only that side', async () => {
      await service.hideConversation(CONV, EMPLOYER);
      const data = prisma.profileConversation.update.mock.calls.at(-1)[0].data;
      expect(data).toHaveProperty('employer_hidden_at');
      expect(data).not.toHaveProperty('worker_hidden_at');
    });

    it('never deletes a message', async () => {
      // The rows are evidence — for a claim, and for reviewing a redaction —
      // and the other party keeps their whole history.
      prisma.profileMessage.deleteMany = jest.fn();
      prisma.profileConversation.delete = jest.fn();
      await service.hideConversation(CONV, EMPLOYER);
      expect(prisma.profileMessage.deleteMany).not.toHaveBeenCalled();
      expect(prisma.profileConversation.delete).not.toHaveBeenCalled();
    });

    it('clears the unread badge along with it', async () => {
      await service.hideConversation(CONV, EMPLOYER);
      expect(prisma.profileMessage.updateMany).toHaveBeenCalled();
    });

    it('refuses a third party', async () => {
      await expect(service.hideConversation(CONV, STRANGER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('shows that side only what came after', async () => {
      const hiddenAt = new Date('2026-09-22T10:00:00Z');
      prisma.profileConversation.findUnique.mockResolvedValue({
        ...conversation,
        employer_hidden_at: hiddenAt,
      });
      await service.listMessages(CONV, EMPLOYER);
      expect(
        prisma.profileMessage.findMany.mock.calls[0][0].where.created_at,
      ).toEqual({ gt: hiddenAt });
    });

    it('leaves the other side’s thread whole', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue({
        ...conversation,
        employer_hidden_at: new Date(),
      });
      await service.listMessages(CONV, WORKER);
      expect(
        prisma.profileMessage.findMany.mock.calls[0][0].where.created_at,
      ).toBeUndefined();
    });
  });

  describe('reporting a redaction', () => {
    it('only lets the author report', async () => {
      prisma.profileMessage.findFirst.mockResolvedValue({
        id: 'm-1',
        sender_id: WORKER,
        moderation_status: MessageModerationStatus.REDACTED,
      });
      await expect(service.reportRedaction('m-1', EMPLOYER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses a report on a message with nothing masked', async () => {
      prisma.profileMessage.findFirst.mockResolvedValue({
        id: 'm-1',
        sender_id: WORKER,
        moderation_status: MessageModerationStatus.CLEAN,
      });
      await expect(service.reportRedaction('m-1', WORKER)).rejects.toThrow(
        /masqué/i,
      );
    });

    it('records one for the author', async () => {
      prisma.profileMessage.findFirst.mockResolvedValue({
        id: 'm-1',
        sender_id: WORKER,
        moderation_status: MessageModerationStatus.REDACTED,
      });
      await service.reportRedaction('m-1', WORKER, 'c’est un prix');
      expect(prisma.redactionReport.createMany).toHaveBeenCalledWith({
        data: [
          { message_id: 'm-1', reporter_id: WORKER, note: 'c’est un prix' },
        ],
        // The unique index on (message, reporter) is what stops a second tap
        // from queueing the same report twice; this is the half of that rule
        // that keeps it from being an error instead.
        skipDuplicates: true,
      });
    });

    it('is a no-op the second time, not an error', async () => {
      prisma.profileMessage.findFirst.mockResolvedValue({
        id: 'm-1',
        sender_id: WORKER,
        moderation_status: MessageModerationStatus.REDACTED,
      });
      prisma.redactionReport.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reportRedaction('m-1', WORKER),
      ).resolves.toBeUndefined();
    });
  });

  describe('the kill switch', () => {
    it('refuses to send when messaging is off', async () => {
      config.get.mockImplementation((key: string) =>
        Promise.resolve(key === 'messaging.enabled' ? 'false' : 'false'),
      );
      await expect(service.sendMessage(CONV, WORKER, 'salut')).rejects.toThrow(
        /indisponible/i,
      );
    });

    it('still lets people READ when messaging is off', async () => {
      // Switching the feature off must not hide conversations people are in
      // the middle of. It stops new messages, nothing else.
      config.get.mockImplementation((key: string) =>
        Promise.resolve(key === 'messaging.enabled' ? 'false' : 'false'),
      );
      await expect(service.listMessages(CONV, WORKER)).resolves.toBeTruthy();
    });
  });
  /**
   * Taking a message back.
   *
   * The rule that matters here is not the happy path — it is that the row
   * survives. A platform whose whole job is catching shared phone numbers
   * cannot offer a button that erases the evidence of one.
   */
  describe('deleteMessage', () => {
    const stored = (over: Record<string, unknown> = {}) => ({
      id: 'm-1',
      sender_id: WORKER,
      conversation_id: CONV,
      deleted_at: null,
      ...over,
    });

    beforeEach(() => {
      prisma.profileMessage.findUnique = jest.fn().mockResolvedValue(stored());
      prisma.profileMessage.update = jest.fn().mockResolvedValue({});
    });

    it('stamps deleted_at and tells BOTH parties', async () => {
      await service.deleteMessage('m-1', WORKER);

      expect(prisma.profileMessage.update).toHaveBeenCalledWith({
        where: { id: 'm-1' },
        data: { deleted_at: expect.any(Date) },
      });
      // The author too: they may have the thread open in a second tab.
      expect(gateway.emitDeleted).toHaveBeenCalledWith(WORKER, CONV, 'm-1');
      expect(gateway.emitDeleted).toHaveBeenCalledWith(EMPLOYER, CONV, 'm-1');
    });

    it('NEVER erases the body or the redaction offsets', async () => {
      await service.deleteMessage('m-1', WORKER);

      const [[call]] = prisma.profileMessage.update.mock.calls;
      expect(call.data).toEqual({ deleted_at: expect.any(Date) });
      expect(call.data).not.toHaveProperty('body');
      // Nothing may sweep the offsets away either — they are moderation's
      // record of what was caught.
      expect(prisma.messageRedaction).toBeUndefined();
    });

    it('refuses the recipient', async () => {
      await expect(service.deleteMessage('m-1', EMPLOYER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.profileMessage.update).not.toHaveBeenCalled();
    });

    it("hides a message in somebody else's conversation behind a 404", async () => {
      // NotFound rather than Forbidden, like requireParticipant: "it exists but
      // is not yours" is itself information about who is talking to whom.
      await expect(service.deleteMessage('m-1', STRANGER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s an unknown message', async () => {
      prisma.profileMessage.findUnique.mockResolvedValue(null);
      await expect(service.deleteMessage('nope', WORKER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('is idempotent — a second tap is not an error', async () => {
      prisma.profileMessage.findUnique.mockResolvedValue(
        stored({ deleted_at: new Date() }),
      );

      await expect(
        service.deleteMessage('m-1', WORKER),
      ).resolves.toBeUndefined();
      expect(prisma.profileMessage.update).not.toHaveBeenCalled();
      expect(gateway.emitDeleted).not.toHaveBeenCalled();
    });

    it('refuses once the conversation is closed', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue({
        ...conversation,
        closed_at: new Date(),
      });

      await expect(service.deleteMessage('m-1', WORKER)).rejects.toThrow(
        /close/i,
      );
    });
  });

  describe('the tombstone a deleted message leaves', () => {
    it('shows both sides an empty message, not a hole in the thread', async () => {
      // Deliberately a REDACTED message with offsets: if the tombstone leaked
      // either the body or the spans, this is where it would show.
      prisma.profileMessage.findMany.mockResolvedValue([
        storedMessage({ deleted_at: new Date('2026-09-23T10:00:00Z') }),
      ]);
      prisma.profileMessage.count.mockResolvedValue(1);

      for (const viewer of [WORKER, EMPLOYER]) {
        const { data } = await service.listMessages(CONV, viewer);

        expect(data[0].deletedAt).toBeInstanceOf(Date);
        expect(data[0].body).toBe('');
        expect(data[0].redactions).toEqual([]);
        expect(data[0].reported).toBe(false);
      }
    });

    it('still lists it, rather than dropping it out of the thread', async () => {
      // The `where` must NOT filter deleted_at — a message that simply vanished
      // mid-conversation reads as a bug, and lets a thread be rewritten.
      prisma.profileMessage.findMany.mockResolvedValue([]);
      await service.listMessages(CONV, WORKER);

      const [[query]] = prisma.profileMessage.findMany.mock.calls;
      expect(query.where).not.toHaveProperty('deleted_at');
    });

    it('does not let a deleted message keep a thread unread', async () => {
      await service.markRead(CONV, EMPLOYER);

      const [[query]] = prisma.profileMessage.updateMany.mock.calls;
      expect(query.where.deleted_at).toBeNull();
    });
  });
});
