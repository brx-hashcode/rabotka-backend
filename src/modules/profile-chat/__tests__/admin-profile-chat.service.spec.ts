import { MessageModerationStatus, RedactionCategory } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { AdminProfileChatService } from '../admin-profile-chat.service';

const CONV = 'c-1';
const WORKER = 'w-1';
const EMPLOYER = 'e-1';

const party = (id: string, first: string, last: string) => ({
  id,
  first_name: first,
  last_name: last,
  phone: '+242060000000',
  avatar_url: null,
});

const conversationRow = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  worker_id: WORKER,
  employer_id: EMPLOYER,
  application_id: 'a-1',
  closed_at: null,
  last_message_at: new Date('2026-09-23T10:00:00Z'),
  worker_last_read_at: null,
  employer_last_read_at: null,
  worker_hidden_at: null,
  employer_hidden_at: null,
  created_at: new Date('2026-09-20T08:00:00Z'),
  updated_at: new Date('2026-09-23T10:00:00Z'),
  worker: party(WORKER, 'Sara', 'Colombe'),
  employer: party(EMPLOYER, 'Marie', 'Employeuse'),
  application: { id: 'a-1', job_offer: { id: 'j-1', title: 'Ménage bureau' } },
  ...over,
});

describe('AdminProfileChatService', () => {
  let service: AdminProfileChatService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      profileConversation: {
        findMany: jest.fn().mockResolvedValue([conversationRow()]),
        findUnique: jest.fn().mockResolvedValue(conversationRow()),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({}),
      },
      profileMessage: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      messageRedaction: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    service = new AdminProfileChatService(prisma);
  });

  const whereOf = () => prisma.profileConversation.findMany.mock.calls[0][0].where;

  describe('the list', () => {
    it('carries no message text of any kind', async () => {
      // The leak guard. This list is the MODERATOR surface; a last-message
      // preview is message body, and putting one here would make the whole
      // two-tier split decorative.
      const { data } = await service.list({});
      const keys = Object.keys(data[0]);

      expect(keys).not.toContain('body');
      expect(keys).not.toContain('preview');
      expect(keys).not.toContain('lastMessagePreview');
      expect(JSON.stringify(data)).not.toMatch(/body|preview/i);
    });

    it('does NOT hide conversations whose every message was held', async () => {
      // `sendMessage` refuses to bump `last_message_at` for a HELD message, so
      // a thread of nothing but withheld messages has none — and it is the most
      // interesting row in the table, not the least.
      await service.list({});
      expect(whereOf()).not.toHaveProperty('last_message_at');
    });

    it('ignores per-side hiding', async () => {
      // "Supprimer la discussion" clears one side's copy. A moderation tool the
      // suspect can empty is not a moderation tool.
      await service.list({});
      const serialised = JSON.stringify(whereOf());

      expect(serialised).not.toContain('worker_hidden_at');
      expect(serialised).not.toContain('employer_hidden_at');
    });

    it('still reports each side’s cleared-at mark as metadata', async () => {
      prisma.profileConversation.findMany.mockResolvedValue([
        conversationRow({ worker_hidden_at: new Date('2026-09-22T09:00:00Z') }),
      ]);

      const { data } = await service.list({});
      expect(data[0].worker.hiddenAt).toBe('2026-09-22T09:00:00.000Z');
      expect(data[0].employer.hiddenAt).toBeNull();
    });

    it('orders by newest activity with nulls last', async () => {
      await service.list({});
      const { orderBy } = prisma.profileConversation.findMany.mock.calls[0][0];

      expect(orderBy[0]).toEqual({
        last_message_at: { sort: 'desc', nulls: 'last' },
      });
    });

    it('tallies moderation counts per conversation', async () => {
      prisma.profileMessage.groupBy.mockResolvedValue([
        {
          conversation_id: CONV,
          moderation_status: MessageModerationStatus.CLEAN,
          _count: { _all: 5 },
        },
        {
          conversation_id: CONV,
          moderation_status: MessageModerationStatus.REDACTED,
          _count: { _all: 3 },
        },
        {
          conversation_id: CONV,
          moderation_status: MessageModerationStatus.HELD,
          _count: { _all: 2 },
        },
      ]);
      prisma.profileMessage.findMany.mockResolvedValue([
        { conversation_id: CONV },
        { conversation_id: CONV },
      ]);

      const { data } = await service.list({});
      expect(data[0]).toMatchObject({
        messageCount: 10,
        redactedCount: 3,
        heldCount: 2,
        pendingReportCount: 2,
      });
    });

    it('reports a held-only conversation with no last activity', async () => {
      prisma.profileConversation.findMany.mockResolvedValue([
        conversationRow({ last_message_at: null }),
      ]);
      prisma.profileMessage.groupBy.mockResolvedValue([
        {
          conversation_id: CONV,
          moderation_status: MessageModerationStatus.HELD,
          _count: { _all: 4 },
        },
      ]);

      const { data } = await service.list({});
      expect(data[0].lastMessageAt).toBeNull();
      expect(data[0].heldCount).toBe(4);
    });

    it('AND-s several flags rather than OR-ing them', async () => {
      await service.list({ flags: ['HELD', 'DIRECT'] });
      const where = whereOf();

      expect(where.AND).toHaveLength(2);
      expect(where.AND).toContainEqual({ application_id: null });
    });

    it('treats asking for both statuses as asking for neither', async () => {
      await service.list({ status: ['OPEN', 'CLOSED'] });
      expect(whereOf()).not.toHaveProperty('closed_at');
    });

    it('splits a two-word search across first and last name', async () => {
      await service.list({ q: 'Marie Employeuse' });
      const where = whereOf();

      expect(where.OR).toContainEqual({
        employer: {
          first_name: { contains: 'Marie', mode: 'insensitive' },
          last_name: { contains: 'Employeuse', mode: 'insensitive' },
        },
      });
    });
  });

  describe('locking', () => {
    it('closes an open conversation', async () => {
      await service.close(CONV);

      expect(prisma.profileConversation.update).toHaveBeenCalledWith({
        where: { id: CONV },
        data: { closed_at: expect.any(Date) },
      });
    });

    it('does not move the timestamp when it is already closed', async () => {
      // A double tap must not rewrite WHEN a conversation was silenced — that
      // is the field somebody will later be asked to justify.
      prisma.profileConversation.findUnique.mockResolvedValue(
        conversationRow({ closed_at: new Date('2026-09-01T00:00:00Z') }),
      );

      await service.close(CONV);
      expect(prisma.profileConversation.update).not.toHaveBeenCalled();
    });

    it('reopens a closed conversation', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue(
        conversationRow({ closed_at: new Date('2026-09-01T00:00:00Z') }),
      );

      await service.reopen(CONV);
      expect(prisma.profileConversation.update).toHaveBeenCalledWith({
        where: { id: CONV },
        data: { closed_at: null },
      });
    });

    it('is a no-op when reopening an open conversation', async () => {
      await service.reopen(CONV);
      expect(prisma.profileConversation.update).not.toHaveBeenCalled();
    });

    it('refuses an unknown conversation', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue(null);
      await expect(service.close('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('the detail', () => {
    it('counts redactions by category, zero-filled', async () => {
      prisma.messageRedaction.groupBy.mockResolvedValue([
        { category: RedactionCategory.PHONE, _count: { _all: 7 } },
      ]);

      const detail = await service.detail(CONV);
      expect(detail.redactionsByCategory.PHONE).toBe(7);
      // Zero-filled so the UI can map over the categories without holes.
      expect(detail.redactionsByCategory.MESSAGING_HANDLE).toBe(0);
    });

    it('refuses an unknown conversation', async () => {
      prisma.profileConversation.findUnique.mockResolvedValue(null);
      await expect(service.detail('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
