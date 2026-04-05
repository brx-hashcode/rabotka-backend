import { PaymentStatusGateway } from '../payment-status.gateway';
import { Logger } from '@nestjs/common';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

function makeGateway() {
  const gateway = new PaymentStatusGateway();
  const mockRoom = { emit: jest.fn() };
  gateway.server = {
    to: jest.fn().mockReturnValue(mockRoom),
  } as unknown as PaymentStatusGateway['server'];
  return { gateway, mockRoom };
}

function makeSocket(id = 'socket-1') {
  return {
    id,
    join: jest.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<PaymentStatusGateway['handleJoinPayment']>[0];
}

describe('PaymentStatusGateway', () => {
  describe('handleConnection / handleDisconnect', () => {
    it('logs connection without throwing', () => {
      const { gateway } = makeGateway();
      expect(() => gateway.handleConnection(makeSocket())).not.toThrow();
    });

    it('logs disconnection without throwing', () => {
      const { gateway } = makeGateway();
      expect(() => gateway.handleDisconnect(makeSocket())).not.toThrow();
    });
  });

  describe('handleJoinPayment()', () => {
    it('joins client to room payment:{token}', () => {
      const { gateway } = makeGateway();
      const socket = makeSocket();
      gateway.handleJoinPayment(socket, { token: 'abc123' });
      expect(socket.join).toHaveBeenCalledWith('payment:abc123');
    });

    it('does nothing when token is empty', () => {
      const { gateway } = makeGateway();
      const socket = makeSocket();
      gateway.handleJoinPayment(socket, { token: '' });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('does nothing when data is undefined', () => {
      const { gateway } = makeGateway();
      const socket = makeSocket();
      // @ts-expect-error — testing undefined data guard
      gateway.handleJoinPayment(socket, undefined);
      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('emitPaymentStatus()', () => {
    it('emits APPROVED status to the correct room', () => {
      const { gateway, mockRoom } = makeGateway();
      gateway.emitPaymentStatus('tok-1', 'APPROVED');
      expect(gateway.server.to).toHaveBeenCalledWith('payment:tok-1');
      expect(mockRoom.emit).toHaveBeenCalledWith('payment-status', { status: 'APPROVED' });
    });

    it('emits REJECTED status to the correct room', () => {
      const { gateway, mockRoom } = makeGateway();
      gateway.emitPaymentStatus('tok-2', 'REJECTED');
      expect(gateway.server.to).toHaveBeenCalledWith('payment:tok-2');
      expect(mockRoom.emit).toHaveBeenCalledWith('payment-status', { status: 'REJECTED' });
    });
  });
});
