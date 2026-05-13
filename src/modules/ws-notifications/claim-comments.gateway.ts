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
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  namespace: '/claim-comments',
  cors: {
    origin: (
      _origin: string,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class ClaimCommentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ClaimCommentsGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    this.logger.debug(`Claim comments client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Claim comments client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-claim')
  handleJoinClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { claimId: string },
  ): void {
    if (!data?.claimId) return;
    const room = `claim:${data.claimId}`;
    void client.join(room);
    this.logger.debug(`Client ${client.id} joined room ${room}`);
  }

  emitNewComment(claimId: string, comment: Record<string, unknown>): void {
    this.server.to(`claim:${claimId}`).emit('comment:new', comment);
  }

  emitDeletedComment(claimId: string, commentId: string): void {
    this.server.to(`claim:${claimId}`).emit('comment:deleted', { commentId });
  }
}
