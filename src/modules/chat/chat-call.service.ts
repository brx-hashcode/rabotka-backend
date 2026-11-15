import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatConversationType, ChatMessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  newVisioRoom,
  signJitsiJoin,
  type JitsiJoin,
} from '../../common/services/jitsi/jitsi-token';
import {
  ChatService,
  type ChatCallInfo,
  type ChatMessageItem,
} from './chat.service';

/** A call nobody closed (a crashed tab) is over after this long. */
export const STALE_CALL_MS = 6 * 60 * 60 * 1000;
/** How long a call token lasts: longer than any team call. */
const CALL_TOKEN_MS = 12 * 60 * 60 * 1000;

const senderSelect = {
  sender: { select: { first_name: true, last_name: true } },
} as const;

const fullName = (u: { first_name: string; last_name: string }) =>
  `${u.first_name} ${u.last_name}`.trim();

export type CallStarted = {
  /** False when the call was already going on: it is only joined. */
  started: boolean;
  room: string;
  message: ChatMessageItem | null;
  recipientIds: string[];
  conversation: { id: string; name: string | null; type: ChatConversationType };
  callerName: string;
};

/**
 * Video calls in the admins' team chat, on our own Jitsi. One call at a time
 * per conversation: starting one posts a CALL card (and rings the others);
 * anyone in the conversation joins it; it ends when the last one leaves.
 */
@Injectable()
export class ChatCallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly chat: ChatService,
  ) {}

  async start(userId: string, conversationId: string): Promise<CallStarted> {
    await this.chat.assertMembership(userId, conversationId);
    await this.endIfStale(conversationId);
    const [conversation, me] = await Promise.all([
      this.prisma.chatConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { id: true, name: true, type: true, active_call_room: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { first_name: true, last_name: true },
      }),
    ]);
    const conv = {
      id: conversation.id,
      name: conversation.name,
      type: conversation.type,
    };
    if (conversation.active_call_room) {
      return {
        started: false,
        room: conversation.active_call_room,
        message: null,
        recipientIds: [],
        conversation: conv,
        callerName: fullName(me),
      };
    }

    const room = newVisioRoom('RabotkaTeam');
    const now = new Date();
    // Only one call may start: the update is conditional on no call there.
    const claimed = await this.prisma.chatConversation.updateMany({
      where: { id: conversationId, active_call_room: null },
      data: { active_call_room: room, active_call_started_at: now },
    });
    if (claimed.count === 0) return this.start(userId, conversationId);

    const message = await this.prisma.chatMessage.create({
      data: {
        conversation_id: conversationId,
        sender_id: userId,
        kind: ChatMessageKind.CALL,
        metadata: { room } satisfies ChatCallInfo,
      },
      include: senderSelect,
    });
    // The caller has seen their own card.
    await this.prisma.chatParticipant.update({
      where: {
        idx_chat_participant_unique: {
          conversation_id: conversationId,
          user_id: userId,
        },
      },
      data: { last_read_at: now },
    });
    const participantIds = await this.participants(conversationId);
    return {
      started: true,
      room,
      message: this.chat.toMessageItem(message, fullName(message.sender)),
      recipientIds: participantIds.filter((id) => id !== userId),
      conversation: conv,
      callerName: fullName(me),
    };
  }

  /** A token for the conversation's call: every admin in it is a moderator. */
  async join(
    userId: string,
    conversationId: string,
  ): Promise<JitsiJoin & { title: string }> {
    await this.chat.assertMembership(userId, conversationId);
    await this.endIfStale(conversationId);
    const [conversation, user] = await Promise.all([
      this.prisma.chatConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          name: true,
          type: true,
          active_call_room: true,
          participants: {
            select: {
              user_id: true,
              user: { select: { first_name: true, last_name: true } },
            },
          },
        },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { first_name: true, last_name: true, email: true },
      }),
    ]);
    const room = conversation.active_call_room;
    if (!room) throw new BadRequestException('This call has ended.');
    // A direct call is named after the other person; a group, after itself.
    const other = conversation.participants.find((p) => p.user_id !== userId);
    const title =
      conversation.type === ChatConversationType.DIRECT && other
        ? fullName(other.user)
        : (conversation.name ?? 'Team call');
    const join = await signJitsiJoin(this.config, {
      room,
      user: {
        id: userId,
        name: fullName(user) || user.email,
        email: user.email,
        moderator: true,
      },
      expiresAt: new Date(Date.now() + CALL_TOKEN_MS),
    });
    return { ...join, title };
  }

  /**
   * Someone left the call; `remaining` is how many were still in it (Jitsi's
   * count, sent by the leaving tab). The last one out ends it.
   */
  async leave(
    userId: string,
    conversationId: string,
    remaining: number,
  ): Promise<{ ended: ChatMessageItem | null; participantIds: string[] }> {
    await this.chat.assertMembership(userId, conversationId);
    if (remaining > 0) return { ended: null, participantIds: [] };
    return this.end(conversationId);
  }

  /** Who started the call going on: the one told of a decline. */
  async callerOf(userId: string, conversationId: string) {
    await this.chat.assertMembership(userId, conversationId);
    const [card, me] = await Promise.all([
      this.prisma.chatMessage.findFirst({
        where: { conversation_id: conversationId, kind: ChatMessageKind.CALL },
        orderBy: { created_at: 'desc' },
        select: { sender_id: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { first_name: true, last_name: true },
      }),
    ]);
    return { callerId: card?.sender_id ?? null, name: fullName(me) };
  }

  // ── Inside ───────────────────────────────────────────────────────────

  /** A call left open by a crashed tab doesn't block the next one forever. */
  private async endIfStale(conversationId: string) {
    const c = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { active_call_started_at: true },
    });
    const started = c?.active_call_started_at?.getTime();
    if (started && Date.now() - started > STALE_CALL_MS) {
      await this.end(conversationId);
    }
  }

  /** Closes the call and writes how long it lasted on its card. */
  private async end(conversationId: string) {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { active_call_room: true, active_call_started_at: true },
    });
    const room = conversation?.active_call_room;
    if (!room) return { ended: null, participantIds: [] };
    const cleared = await this.prisma.chatConversation.updateMany({
      where: { id: conversationId, active_call_room: room },
      data: { active_call_room: null, active_call_started_at: null },
    });
    // Two tabs leaving together: only one closes it.
    if (cleared.count === 0) return { ended: null, participantIds: [] };

    const card = await this.prisma.chatMessage.findFirst({
      where: {
        conversation_id: conversationId,
        kind: ChatMessageKind.CALL,
        metadata: { path: ['room'], equals: room },
      },
      orderBy: { created_at: 'desc' },
    });
    const participantIds = await this.participants(conversationId);
    if (!card) return { ended: null, participantIds };
    const startedAt = (
      conversation.active_call_started_at ?? card.created_at
    ).getTime();
    const endedAt = new Date();
    const metadata: ChatCallInfo = {
      room,
      endedAt: endedAt.toISOString(),
      durationSec: Math.max(
        0,
        Math.round((endedAt.getTime() - startedAt) / 1000),
      ),
    };
    const updated = await this.prisma.chatMessage.update({
      where: { id: card.id },
      data: { metadata },
      include: senderSelect,
    });
    return {
      ended: this.chat.toMessageItem(updated, fullName(updated.sender)),
      participantIds,
    };
  }

  private async participants(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.chatParticipant.findMany({
      where: { conversation_id: conversationId },
      select: { user_id: true },
    });
    return rows.map((r) => r.user_id);
  }
}
