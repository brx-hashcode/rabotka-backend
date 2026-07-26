import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ChatConversationType } from '@prisma/client';
import { ChatService } from '../chat.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

const ME = 'user-me';
const OTHER = 'user-other';

function makePrismaMock() {
  return {
    chatParticipant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    chatConversation: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn(),
    },
    chatMessage: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

describe('ChatService', () => {
  let service: ChatService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ChatService);
  });

  describe('assertMembership', () => {
    it('throws when the user is not a participant', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue(null);
      await expect(service.assertMembership(ME, 'c1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('passes when the user is a participant', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      await expect(service.assertMembership(ME, 'c1')).resolves.toBeUndefined();
    });
  });

  describe('getOrCreateDirect', () => {
    it('reuses an existing 1:1 conversation (no create)', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: OTHER });
      prisma.chatConversation.findFirst.mockResolvedValue({ id: 'existing' });
      // getConversation → assertMembership + findUnique(one conversation)
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique.mockResolvedValue({
        id: 'existing',
        type: ChatConversationType.DIRECT,
        name: null,
        is_team: false,
        updated_at: new Date(),
        participants: [
          {
            user_id: ME,
            last_read_at: null,
            user: { id: ME, first_name: 'Me', last_name: 'X', role: 'ADMIN' },
          },
          {
            user_id: OTHER,
            last_read_at: null,
            user: { id: OTHER, first_name: 'O', last_name: 'Y', role: 'ADMIN' },
          },
        ],
        messages: [],
      });

      const convo = await service.getOrCreateDirect(ME, OTHER);

      expect(convo.id).toBe('existing');
      expect(prisma.chatConversation.create).not.toHaveBeenCalled();
    });

    it('rejects a self conversation', async () => {
      await expect(service.getOrCreateDirect(ME, ME)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('ensureTeamConversation', () => {
    it('syncs participants: adds new active users, removes stale', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      prisma.chatConversation.findFirst.mockResolvedValue({ id: 'team' });
      // existing participants: a (kept), c (stale → remove); b is missing → add
      prisma.chatParticipant.findMany.mockResolvedValue([
        { user_id: 'a' },
        { user_id: 'c' },
      ]);

      const id = await service.ensureTeamConversation();

      expect(id).toBe('team');
      expect(prisma.chatParticipant.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [{ conversation_id: 'team', user_id: 'b' }],
        }),
      );
      expect(prisma.chatParticipant.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversation_id: 'team', user_id: { in: ['c'] } },
        }),
      );
    });
  });

  describe('member management', () => {
    it('refuses to edit members of the Team channel', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' }); // membership
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: ChatConversationType.GROUP,
        is_team: true,
      });
      await expect(service.addMembers(ME, 'team', ['b'])).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.chatParticipant.createMany).not.toHaveBeenCalled();
    });

    it('refuses to add members to a direct conversation', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: ChatConversationType.DIRECT,
        is_team: false,
      });
      await expect(service.addMembers(ME, 'dm', ['b'])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('adds only new, active users and returns the added ids', async () => {
      // assertEditableGroup: membership + group lookup
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique
        .mockResolvedValueOnce({
          type: ChatConversationType.GROUP,
          is_team: false,
        })
        // getConversation → the mapped conversation payload
        .mockResolvedValueOnce({
          id: 'g1',
          type: ChatConversationType.GROUP,
          name: 'Group',
          is_team: false,
          updated_at: new Date(),
          participants: [
            {
              user_id: ME,
              last_read_at: null,
              user: { id: ME, first_name: 'Me', last_name: 'X', role: 'ADMIN' },
            },
          ],
          messages: [],
        });
      // existing participants (for the add diff) — ME already in, b is new
      prisma.chatParticipant.findMany.mockResolvedValue([{ user_id: ME }]);
      prisma.user.findMany.mockResolvedValue([{ id: ME }, { id: 'b' }]);

      const { addedIds } = await service.addMembers(ME, 'g1', [ME, 'b']);

      expect(addedIds).toEqual(['b']);
      expect(prisma.chatParticipant.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [{ conversation_id: 'g1', user_id: 'b' }],
        }),
      );
    });
  });

  describe('creator-only group controls', () => {
    it('lets a member leave (self-removal) even if not the creator', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique
        .mockResolvedValueOnce({
          type: ChatConversationType.GROUP,
          is_team: false,
          created_by: 'someone-else',
        })
        .mockResolvedValueOnce({
          id: 'g1',
          type: ChatConversationType.GROUP,
          name: 'G',
          is_team: false,
          created_by: 'someone-else',
          updated_at: new Date(),
          participants: [
            {
              user_id: 'other',
              last_read_at: null,
              user: {
                id: 'other',
                first_name: 'O',
                last_name: 'Y',
                role: 'ADMIN',
              },
            },
          ],
          messages: [],
        });

      await expect(service.removeMember(ME, 'g1', ME)).resolves.toBeDefined();
      expect(prisma.chatParticipant.deleteMany).toHaveBeenCalled();
    });

    it('refuses to remove another member when not the creator', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique.mockResolvedValueOnce({
        type: ChatConversationType.GROUP,
        is_team: false,
        created_by: 'someone-else',
      });
      await expect(service.removeMember(ME, 'g1', 'victim')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.chatParticipant.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes a group only for its creator', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique.mockResolvedValueOnce({
        type: ChatConversationType.GROUP,
        is_team: false,
        created_by: ME,
      });
      prisma.chatParticipant.findMany.mockResolvedValue([
        { user_id: ME },
        { user_id: 'b' },
      ]);

      const res = await service.deleteGroup(ME, 'g1');

      expect(res.participantIds.sort()).toEqual([ME, 'b'].sort());
      expect(prisma.chatConversation.delete).toHaveBeenCalledWith({
        where: { id: 'g1' },
      });
    });

    it('refuses group deletion by a non-creator', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatConversation.findUnique.mockResolvedValueOnce({
        type: ChatConversationType.GROUP,
        is_team: false,
        created_by: 'someone-else',
      });
      await expect(service.deleteGroup(ME, 'g1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.chatConversation.delete).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('notifies recipients = participants − sender', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' }); // membership
      prisma.$transaction.mockResolvedValue([
        {
          id: 'm1',
          conversation_id: 'c1',
          sender_id: ME,
          body: 'hi',
          attachments: null,
          created_at: new Date(),
          edited_at: null,
          deleted_at: null,
          sender: { first_name: 'Me', last_name: 'X' },
        },
        {},
        {},
      ]);
      prisma.chatConversation.findUniqueOrThrow.mockResolvedValue({
        id: 'c1',
        type: ChatConversationType.GROUP,
        name: 'Team',
      });
      prisma.chatParticipant.findMany.mockResolvedValue([
        { user_id: ME },
        { user_id: 'b' },
        { user_id: 'c' },
      ]);

      const result = await service.sendMessage(ME, 'c1', { body: 'hi' });

      expect(result.message.body).toBe('hi');
      expect(result.recipientIds.sort()).toEqual(['b', 'c']);
      expect(result.recipientIds).not.toContain(ME);
    });

    it('rejects an empty message (no body, no attachments)', async () => {
      prisma.chatParticipant.findUnique.mockResolvedValue({ id: 'p1' });
      await expect(
        service.sendMessage(ME, 'c1', { body: '   ' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
