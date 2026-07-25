import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import {
  ChatService,
  type ChatAttachment,
  type ChatConversationItem,
  type ChatMessageItem,
} from './chat.service';

type AdminJwtPayload = { sub: string; type?: string };

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: (
      _origin: string,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => callback(null, true),
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  // userId -> number of live sockets (for presence).
  private readonly presence = new Map<string, number>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ── Connection lifecycle ────────────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    const userId = this.authenticate(client);
    if (!userId) {
      client.disconnect(true);
      return;
    }
    client.data.userId = userId;

    // Personal room (notifications / unread) + every conversation room.
    void client.join(`user:${userId}`);
    const convos = await this.chatService.listConversations(userId);
    for (const c of convos) void client.join(`conv:${c.id}`);

    const next = (this.presence.get(userId) ?? 0) + 1;
    this.presence.set(userId, next);
    if (next === 1) this.broadcastPresence(userId, true);
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    const remaining = (this.presence.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      this.presence.delete(userId);
      this.broadcastPresence(userId, false);
    } else {
      this.presence.set(userId, remaining);
    }
  }

  private authenticate(client: Socket): string | null {
    try {
      const cookieName = this.config.get<string>('AUTH_COOKIE_NAME');
      const cookies = parseCookies(client.handshake.headers.cookie);
      const token =
        (cookieName ? cookies[cookieName] : undefined) ??
        (client.handshake.auth?.token as string | undefined);
      if (!token) return null;
      const payload = this.jwtService.verify<AdminJwtPayload>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      if (payload.type !== 'admin' || !payload.sub) return null;
      return payload.sub;
    } catch {
      return null;
    }
  }

  // ── Client → server ─────────────────────────────────────────────────────────

  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      body?: string;
      attachments?: ChatAttachment[];
    },
  ): Promise<{ ok: boolean; message?: ChatMessageItem; error?: string }> {
    const userId = client.data.userId as string | undefined;
    if (!userId || !data?.conversationId)
      return { ok: false, error: 'bad request' };
    try {
      const result = await this.chatService.sendMessage(
        userId,
        data.conversationId,
        {
          body: data.body,
          attachments: data.attachments,
        },
      );
      this.emitNewMessage(result.message, result.recipientIds, {
        id: result.conversation.id,
        name: result.conversation.name,
      });
      return { ok: true, message: result.message };
    } catch (err) {
      this.logger.warn(`message:send failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; isTyping: boolean },
  ): void {
    const userId = client.data.userId as string | undefined;
    if (!userId || !data?.conversationId) return;
    client.to(`conv:${data.conversationId}`).emit('typing', {
      conversationId: data.conversationId,
      userId,
      isTyping: !!data.isTyping,
    });
  }

  @SubscribeMessage('read')
  async handleRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ): Promise<void> {
    const userId = client.data.userId as string | undefined;
    if (!userId || !data?.conversationId) return;
    await this.chatService
      .markRead(userId, data.conversationId)
      .catch(() => undefined);
    this.server.to(`conv:${data.conversationId}`).emit('read', {
      conversationId: data.conversationId,
      userId,
      readAt: new Date().toISOString(),
    });
  }

  // ── Server → client emit helpers (also used by the controller) ──────────────

  /**
   * Emit a new message to everyone in the conversation room, and send a
   * `chat:notification` to each recipient's personal room (recipients =
   * participants − sender). The sender is never notified.
   */
  emitNewMessage(
    message: ChatMessageItem,
    recipientIds: string[],
    conversation: { id: string; name: string | null },
  ): void {
    this.server
      .to(`conv:${message.conversationId}`)
      .emit('message:new', message);

    const preview =
      message.body?.slice(0, 140) ??
      (message.attachments.length > 0 ? '📎 Attachment' : '');
    for (const recipientId of recipientIds) {
      this.server.to(`user:${recipientId}`).emit('chat:notification', {
        conversationId: message.conversationId,
        conversationName: conversation.name,
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
        preview,
        createdAt: message.createdAt,
      });
    }
  }

  /**
   * Broadcast a read receipt to the conversation room. Used by the REST
   * mark-read endpoint so a reader who opens a conversation via HTTP (not the
   * socket handler) still lets the sender's "seen" ticks update live.
   */
  emitRead(conversationId: string, userId: string): void {
    this.server.to(`conv:${conversationId}`).emit('read', {
      conversationId,
      userId,
      readAt: new Date().toISOString(),
    });
  }

  emitEditedMessage(message: ChatMessageItem): void {
    this.server
      .to(`conv:${message.conversationId}`)
      .emit('message:edited', message);
  }

  emitDeletedMessage(conversationId: string, messageId: string): void {
    this.server.to(`conv:${conversationId}`).emit('message:deleted', {
      conversationId,
      messageId,
    });
  }

  /**
   * When a conversation is created (direct/group), make each connected member's
   * sockets join its room so they receive messages without a reconnect.
   */
  joinParticipants(conversation: ChatConversationItem): void {
    const room = `conv:${conversation.id}`;
    for (const p of conversation.participants) {
      this.server.in(`user:${p.userId}`).socketsJoin(room);
    }
  }

  /**
   * Broadcast an updated conversation (e.g. members changed) to everyone in its
   * room plus each current participant's personal room — the latter covers
   * newly added members whose sockets are joining the room this same tick.
   */
  emitConversationUpdated(conversation: ChatConversationItem): void {
    this.server
      .to(`conv:${conversation.id}`)
      .emit('conversation:updated', conversation);
    for (const p of conversation.participants) {
      this.server
        .to(`user:${p.userId}`)
        .emit('conversation:updated', conversation);
    }
  }

  /**
   * Tell a removed member the conversation is gone and drop their sockets from
   * its room so they stop receiving its messages.
   */
  removeParticipant(conversationId: string, userId: string): void {
    const room = `conv:${conversationId}`;
    this.server.to(`user:${userId}`).emit('conversation:removed', {
      conversationId,
    });
    this.server.in(`user:${userId}`).socketsLeave(room);
  }

  private broadcastPresence(userId: string, online: boolean): void {
    this.server.emit('presence', { userId, online });
  }

  onlineUserIds(): string[] {
    return [...this.presence.keys()];
  }
}
