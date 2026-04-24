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
  namespace: '/qr',
  cors: {
    origin: (_origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, true);
    },
    credentials: false,
  },
})
export class QrGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(QrGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    this.logger.debug(`QR client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`QR client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-qr')
  handleJoinQr(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: string },
  ): void {
    if (!data?.sessionId) return;
    void client.join(`qr:${data.sessionId}`);
    this.logger.debug(`Client ${client.id} joined qr:${data.sessionId}`);
  }

  emitConfirmed(sessionId: string): void {
    this.server.to(`qr:${sessionId}`).emit('qr:confirmed');
  }
}
