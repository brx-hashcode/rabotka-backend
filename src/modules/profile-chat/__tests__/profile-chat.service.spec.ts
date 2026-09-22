import {
  ApplicationStatus,
  ContactUnlockStatus,
  MessageModerationStatus,
  Prisma,
} from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProfileChatService } from '../profile-chat.service';
import { PROFILE_NOTIFICATION_EVENT } from '../../profile-notification/profile-notification.events';
import { ModerationService } from '../moderation/moderation.service';

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
  let gateway: { emitMessage: jest.Mock; emitRead: jest.Mock };
  let events: { emit: jest.Mock };
  let queue: { addJob: jest.Mock };

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
      application: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ job_offer: { title: 'Ménage bureau' } }) },
      profileConversation: {
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
      contactUnlockAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Sara', last_name: 'Colombe' }),
      },
      redactionReport: { create: jest.fn().mockResolvedValue({}) },
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

    gateway = { emitMessage: jest.fn(), emitRead: jest.fn() };
    events = { emit: jest.fn() };
    queue = { addJob: jest.fn().mockResolvedValue('job-1') };

    service = new ProfileChatService(
      prisma,
      config as never,
      new ModerationService(config as never),
      gateway as never,
      events as never,
      queue as never,
    );
  });

  /**
   * THE TESTS THAT DECIDE WHETHER THE FEATURE IS REAL.
   *
   * Everything else here is plumbing. If the recipient's payload carries the
   * digits, redacting them in the client is decoration and a network tab
   * defeats the whole product.
   */
  describe('the two views of one message', () => {
    it('gives the author their own text back, with the offsets', async () => {
      const message = await service.sendMessage(
        CONV,
        WORKER,
        BODY_WITH_PHONE,
      );

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
      await expect(
        service.sendMessage(CONV, WORKER, 'salut'),
      ).rejects.toThrow(/close/i);
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
      await expect(
        service.openForApplication(APP, STRANGER),
      ).rejects.toThrow(ForbiddenException);
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

  describe('after the contacts are unlocked', () => {
    it('stops moderating, because both already have the number', async () => {
      prisma.contactUnlockAttempt.findFirst.mockResolvedValue({
        status: ContactUnlockStatus.UNLOCKED,
      });
      prisma.profileMessage.create.mockResolvedValue(
        storedMessage({
          moderation_status: MessageModerationStatus.CLEAN,
          redactions: [],
        }),
      );

      const message = await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);

      expect(message.status).toBe(MessageModerationStatus.CLEAN);
      expect(prisma.profileMessage.create.mock.calls[0][0].data.redactions.create)
        .toEqual([]);
    });

    it('keeps moderating when the config says to', async () => {
      config.get.mockImplementation((key: string) =>
        Promise.resolve(
          key === 'messaging.moderate_after_unlock' ? 'true' : 'true',
        ),
      );
      prisma.contactUnlockAttempt.findFirst.mockResolvedValue({
        status: ContactUnlockStatus.UNLOCKED,
      });

      await service.sendMessage(CONV, WORKER, BODY_WITH_PHONE);

      expect(
        prisma.profileMessage.create.mock.calls[0][0].data.redactions.create,
      ).toHaveLength(1);
    });
  });

  describe('reading', () => {
    it('does not count the reader’s own messages as unread', async () => {
      await service.markRead(CONV, EMPLOYER);
      expect(prisma.profileMessage.updateMany.mock.calls[0][0].where).toMatchObject(
        { sender_id: { not: EMPLOYER } },
      );
    });

    it('stamps the right side of the conversation', async () => {
      await service.markRead(CONV, WORKER);
      expect(
        prisma.profileConversation.update.mock.calls[0][0].data,
      ).toHaveProperty('worker_last_read_at');
    });
  });

  describe('reporting a redaction', () => {
    it('only lets the author report', async () => {
      prisma.profileMessage.findFirst.mockResolvedValue({
        id: 'm-1',
        sender_id: WORKER,
        moderation_status: MessageModerationStatus.REDACTED,
      });
      await expect(
        service.reportRedaction('m-1', EMPLOYER),
      ).rejects.toThrow(ForbiddenException);
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
      expect(prisma.redactionReport.create).toHaveBeenCalled();
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
});
