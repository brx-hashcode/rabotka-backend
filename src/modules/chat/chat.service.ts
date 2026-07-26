import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChatConversationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

export type ChatAttachment = {
  url: string;
  key: string;
  name: string;
  mime: string;
  size: number;
};

export type ChatMessageItem = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string | null;
  attachments: ChatAttachment[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type ChatParticipantItem = {
  userId: string;
  name: string;
  role: string;
  lastReadAt: string | null;
};

export type ChatConversationItem = {
  id: string;
  type: ChatConversationType;
  name: string | null;
  isTeam: boolean;
  createdBy: string | null;
  updatedAt: string;
  participants: ChatParticipantItem[];
  lastMessage: ChatMessageItem | null;
  unreadCount: number;
};

const MESSAGE_PAGE_SIZE = 30;

function fullName(u: { first_name: string; last_name: string }): string {
  return `${u.first_name} ${u.last_name}`.trim();
}

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Membership ─────────────────────────────────────────────────────────────

  async assertMembership(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const participant = await this.prisma.chatParticipant.findUnique({
      where: {
        idx_chat_participant_unique: {
          conversation_id: conversationId,
          user_id: userId,
        },
      },
      select: { id: true },
    });
    if (!participant) {
      throw new ForbiddenException('You are not a member of this conversation');
    }
  }

  async participantUserIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.chatParticipant.findMany({
      where: { conversation_id: conversationId },
      select: { user_id: true },
    });
    return rows.map((r) => r.user_id);
  }

  // ── Team channel ───────────────────────────────────────────────────────────

  /**
   * Get-or-create the single is_team GROUP conversation and sync its members to
   * all active, non-deleted admin users (so new team members appear and removed
   * ones drop off). Cheap to call before listing conversations.
   */
  async ensureTeamConversation(): Promise<string> {
    const activeUsers = await this.prisma.user.findMany({
      where: { is_active: true, deleted_at: null },
      select: { id: true },
    });
    const activeIds = new Set(activeUsers.map((u) => u.id));

    let team = await this.prisma.chatConversation.findFirst({
      where: { is_team: true },
      select: { id: true },
    });
    if (!team) {
      team = await this.prisma.chatConversation.create({
        data: {
          type: ChatConversationType.GROUP,
          name: 'Team',
          is_team: true,
          participants: {
            create: activeUsers.map((u) => ({ user_id: u.id })),
          },
        },
        select: { id: true },
      });
      return team.id;
    }

    const existing = await this.prisma.chatParticipant.findMany({
      where: { conversation_id: team.id },
      select: { user_id: true },
    });
    const existingIds = new Set(existing.map((p) => p.user_id));

    const toAdd = [...activeIds].filter((id) => !existingIds.has(id));
    const toRemove = [...existingIds].filter((id) => !activeIds.has(id));

    if (toAdd.length > 0) {
      await this.prisma.chatParticipant.createMany({
        data: toAdd.map((user_id) => ({
          conversation_id: team.id,
          user_id,
        })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await this.prisma.chatParticipant.deleteMany({
        where: { conversation_id: team.id, user_id: { in: toRemove } },
      });
    }
    return team.id;
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  private readonly conversationInclude = {
    participants: {
      include: {
        user: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            role: true,
          },
        },
      },
    },
    messages: {
      where: { deleted_at: null },
      orderBy: { created_at: 'desc' as const },
      take: 1,
      include: { sender: { select: { first_name: true, last_name: true } } },
    },
  };

  async listConversations(userId: string): Promise<ChatConversationItem[]> {
    await this.ensureTeamConversation();

    const convos = await this.prisma.chatConversation.findMany({
      where: { participants: { some: { user_id: userId } } },
      orderBy: { updated_at: 'desc' },
      include: this.conversationInclude,
    });

    return Promise.all(convos.map((c) => this.mapConversation(userId, c)));
  }

  private async mapConversation(
    userId: string,
    c: Prisma.ChatConversationGetPayload<{
      include: ChatService['conversationInclude'];
    }>,
  ): Promise<ChatConversationItem> {
    const me = c.participants.find((p) => p.user_id === userId);
    const unreadCount = await this.prisma.chatMessage.count({
      where: {
        conversation_id: c.id,
        deleted_at: null,
        sender_id: { not: userId },
        ...(me?.last_read_at ? { created_at: { gt: me.last_read_at } } : {}),
      },
    });
    const last = c.messages[0];
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      isTeam: c.is_team,
      createdBy: c.created_by,
      updatedAt: c.updated_at.toISOString(),
      participants: c.participants.map((p) => ({
        userId: p.user_id,
        name: fullName(p.user),
        role: p.user.role,
        lastReadAt: p.last_read_at?.toISOString() ?? null,
      })),
      lastMessage: last
        ? this.toMessageItem(last, fullName(last.sender))
        : null,
      unreadCount,
    };
  }

  async getOrCreateDirect(
    userId: string,
    otherUserId: string,
  ): Promise<ChatConversationItem> {
    if (userId === otherUserId) {
      throw new ForbiddenException('Cannot start a conversation with yourself');
    }
    const other = await this.prisma.user.findFirst({
      where: { id: otherUserId, is_active: true, deleted_at: null },
      select: { id: true },
    });
    if (!other) throw new NotFoundException('User not found');

    // A DIRECT conversation whose participant set is exactly {userId, otherUserId}.
    const existing = await this.prisma.chatConversation.findFirst({
      where: {
        type: ChatConversationType.DIRECT,
        AND: [
          { participants: { some: { user_id: userId } } },
          { participants: { some: { user_id: otherUserId } } },
        ],
      },
      select: { id: true },
    });

    const id =
      existing?.id ??
      (
        await this.prisma.chatConversation.create({
          data: {
            type: ChatConversationType.DIRECT,
            created_by: userId,
            participants: {
              create: [{ user_id: userId }, { user_id: otherUserId }],
            },
          },
          select: { id: true },
        })
      ).id;

    return this.getConversation(userId, id);
  }

  async createGroup(
    userId: string,
    name: string,
    memberIds: string[],
  ): Promise<ChatConversationItem> {
    const ids = [...new Set([userId, ...memberIds])];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, is_active: true, deleted_at: null },
      select: { id: true },
    });
    const validIds = new Set(users.map((u) => u.id));
    validIds.add(userId);

    const created = await this.prisma.chatConversation.create({
      data: {
        type: ChatConversationType.GROUP,
        name: name.trim() || 'Group',
        created_by: userId,
        participants: {
          create: [...validIds].map((user_id) => ({ user_id })),
        },
      },
      select: { id: true },
    });
    return this.getConversation(userId, created.id);
  }

  async getConversation(
    userId: string,
    conversationId: string,
  ): Promise<ChatConversationItem> {
    await this.assertMembership(userId, conversationId);
    const convo = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      include: this.conversationInclude,
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return this.mapConversation(userId, convo);
  }

  /** Load a group conversation for membership edits, guarding the invariants. */
  private async assertEditableGroup(
    userId: string,
    conversationId: string,
  ): Promise<{ created_by: string | null }> {
    await this.assertMembership(userId, conversationId);
    const convo = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { type: true, is_team: true, created_by: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (convo.type !== ChatConversationType.GROUP) {
      throw new ForbiddenException('Only group members can be changed');
    }
    if (convo.is_team) {
      throw new ForbiddenException(
        'The Team channel syncs automatically and cannot be edited',
      );
    }
    return { created_by: convo.created_by };
  }

  /**
   * Add active team members to a group. Returns the refreshed conversation and
   * the ids that were actually added (for room join + notifications).
   */
  async addMembers(
    userId: string,
    conversationId: string,
    memberIds: string[],
  ): Promise<{ conversation: ChatConversationItem; addedIds: string[] }> {
    await this.assertEditableGroup(userId, conversationId);

    const existing = new Set(await this.participantUserIds(conversationId));
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(memberIds)] },
        is_active: true,
        deleted_at: null,
      },
      select: { id: true },
    });
    const addedIds = users.map((u) => u.id).filter((id) => !existing.has(id));

    if (addedIds.length > 0) {
      await this.prisma.chatParticipant.createMany({
        data: addedIds.map((user_id) => ({
          conversation_id: conversationId,
          user_id,
        })),
        skipDuplicates: true,
      });
    }
    return {
      conversation: await this.getConversation(userId, conversationId),
      addedIds,
    };
  }

  /**
   * Remove a member from a group (or leave, when targetUserId === userId).
   * Returns the refreshed conversation for the remaining members.
   */
  async removeMember(
    userId: string,
    conversationId: string,
    targetUserId: string,
  ): Promise<ChatConversationItem> {
    const { created_by } = await this.assertEditableGroup(
      userId,
      conversationId,
    );
    // Members may remove themselves (leave); removing anyone else is reserved
    // to the group's creator.
    if (targetUserId !== userId && created_by !== userId) {
      throw new ForbiddenException(
        'Only the group creator can remove members',
      );
    }
    await this.prisma.chatParticipant.deleteMany({
      where: { conversation_id: conversationId, user_id: targetUserId },
    });
    // Re-read for the remaining members; the caller (a member) may have left,
    // so map from the target's own perspective only if still present.
    const convo = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      include: this.conversationInclude,
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    const viewer =
      userId === targetUserId ? convo.participants[0]?.user_id : userId;
    return this.mapConversation(viewer ?? userId, convo);
  }

  /**
   * Delete a group entirely — only the creator may do this. Returns the
   * participant ids (before deletion) so the gateway can notify them.
   */
  async deleteGroup(
    userId: string,
    conversationId: string,
  ): Promise<{ participantIds: string[] }> {
    const { created_by } = await this.assertEditableGroup(
      userId,
      conversationId,
    );
    if (created_by !== userId) {
      throw new ForbiddenException(
        'Only the group creator can delete the group',
      );
    }
    const participantIds = await this.participantUserIds(conversationId);
    // Cascades to participants + messages (onDelete: Cascade in the schema).
    await this.prisma.chatConversation.delete({
      where: { id: conversationId },
    });
    return { participantIds };
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async getMessages(
    userId: string,
    conversationId: string,
    cursor?: string,
    limit = MESSAGE_PAGE_SIZE,
  ): Promise<{ messages: ChatMessageItem[]; nextCursor: string | null }> {
    await this.assertMembership(userId, conversationId);

    const rows = await this.prisma.chatMessage.findMany({
      where: { conversation_id: conversationId },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { sender: { select: { first_name: true, last_name: true } } },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Return chronological (oldest→newest) for rendering.
    const messages = page
      .map((m) => this.toMessageItem(m, fullName(m.sender)))
      .reverse();
    return {
      messages,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Persist a message and bump the conversation. Returns the message plus the
   * recipient user ids (participants − sender) for notification fan-out.
   */
  async sendMessage(
    userId: string,
    conversationId: string,
    input: { body?: string | null; attachments?: ChatAttachment[] },
  ): Promise<{
    message: ChatMessageItem;
    recipientIds: string[];
    conversation: {
      id: string;
      type: ChatConversationType;
      name: string | null;
    };
  }> {
    await this.assertMembership(userId, conversationId);

    const body = input.body?.trim() ? input.body.trim() : null;
    const attachments = input.attachments ?? [];
    if (!body && attachments.length === 0) {
      throw new ForbiddenException('Message must have text or an attachment');
    }

    const [message] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: {
          conversation_id: conversationId,
          sender_id: userId,
          body,
          attachments:
            attachments.length > 0
              ? (attachments as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
        include: { sender: { select: { first_name: true, last_name: true } } },
      }),
      this.prisma.chatConversation.update({
        where: { id: conversationId },
        data: { updated_at: new Date() },
      }),
      // Sender has implicitly read their own message.
      this.prisma.chatParticipant.update({
        where: {
          idx_chat_participant_unique: {
            conversation_id: conversationId,
            user_id: userId,
          },
        },
        data: { last_read_at: new Date() },
      }),
    ]);

    const conversation = await this.prisma.chatConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { id: true, type: true, name: true },
    });

    const participantIds = await this.participantUserIds(conversationId);
    const recipientIds = participantIds.filter((id) => id !== userId);

    return {
      message: this.toMessageItem(message, fullName(message.sender)),
      recipientIds,
      conversation,
    };
  }

  async editMessage(
    userId: string,
    messageId: string,
    body: string,
  ): Promise<ChatMessageItem> {
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, sender_id: true, conversation_id: true },
    });
    if (!msg) throw new NotFoundException('Message not found');
    if (msg.sender_id !== userId) {
      throw new ForbiddenException('You can only edit your own messages');
    }
    const updated = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { body: body.trim(), edited_at: new Date() },
      include: { sender: { select: { first_name: true, last_name: true } } },
    });
    return this.toMessageItem(updated, fullName(updated.sender));
  }

  async deleteMessage(
    userId: string,
    messageId: string,
  ): Promise<{ conversationId: string }> {
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, sender_id: true, conversation_id: true },
    });
    if (!msg) throw new NotFoundException('Message not found');
    if (msg.sender_id !== userId) {
      throw new ForbiddenException('You can only delete your own messages');
    }
    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { deleted_at: new Date(), body: null, attachments: Prisma.DbNull },
    });
    return { conversationId: msg.conversation_id };
  }

  async markRead(userId: string, conversationId: string): Promise<void> {
    await this.assertMembership(userId, conversationId);
    await this.prisma.chatParticipant.update({
      where: {
        idx_chat_participant_unique: {
          conversation_id: conversationId,
          user_id: userId,
        },
      },
      data: { last_read_at: new Date() },
    });
  }

  async listTeamUsers(
    excludeUserId: string,
  ): Promise<Array<{ id: string; name: string; role: string }>> {
    const users = await this.prisma.user.findMany({
      where: { is_active: true, deleted_at: null, id: { not: excludeUserId } },
      select: { id: true, first_name: true, last_name: true, role: true },
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
    });
    return users.map((u) => ({ id: u.id, name: fullName(u), role: u.role }));
  }

  // ── Mapping ────────────────────────────────────────────────────────────────

  private toMessageItem(
    m: {
      id: string;
      conversation_id: string;
      sender_id: string;
      body: string | null;
      attachments: Prisma.JsonValue | null;
      created_at: Date;
      edited_at: Date | null;
      deleted_at: Date | null;
    },
    senderName: string,
  ): ChatMessageItem {
    return {
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      senderName,
      body: m.body,
      attachments: Array.isArray(m.attachments)
        ? (m.attachments as unknown as ChatAttachment[])
        : [],
      createdAt: m.created_at.toISOString(),
      editedAt: m.edited_at?.toISOString() ?? null,
      deletedAt: m.deleted_at?.toISOString() ?? null,
    };
  }
}
