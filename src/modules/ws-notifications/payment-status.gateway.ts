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
  namespace: '/payment-status',
  cors: {
    origin: (
      _origin: string,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, true);
    },
    credentials: false,
  },
})
export class PaymentStatusGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PaymentStatusGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    this.logger.debug(`Payment client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Payment client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-payment')
  handleJoinPayment(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { token: string },
  ): void {
    if (!data?.token) return;
    const room = `payment:${data.token}`;
    void client.join(room);
    this.logger.debug(`Client ${client.id} joined room ${room}`);
  }

  /**
   * Called by PaymentRequestService after Monetbil webhook is processed.
   * Pushes the final status to the browser waiting on that payment token.
   */
  emitPaymentStatus(
    token: string,
    status: 'APPROVED' | 'REJECTED',
  ): void {
    this.server.to(`payment:${token}`).emit('payment-status', { status });
  }
}
