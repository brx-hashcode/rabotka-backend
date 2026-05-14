import { Test, TestingModule } from '@nestjs/testing';
import { QrGateway } from '../qr.gateway';

describe('QrGateway', () => {
  let gateway: QrGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [QrGateway],
    }).compile();
    gateway = module.get<QrGateway>(QrGateway);
    // Set up a mock server
    (gateway as any).server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
  });

  it('handleConnection logs client connected', () => {
    const client = { id: 'socket-1' } as any;
    expect(() => gateway.handleConnection(client)).not.toThrow();
  });

  it('handleDisconnect logs client disconnected', () => {
    const client = { id: 'socket-1' } as any;
    expect(() => gateway.handleDisconnect(client)).not.toThrow();
  });

  it('handleJoinQr joins the qr room', () => {
    const client = { id: 'socket-1', join: jest.fn() } as any;
    gateway.handleJoinQr(client, { sessionId: 'session-1' });
    expect(client.join).toHaveBeenCalledWith('qr:session-1');
  });

  it('handleJoinQr does nothing without sessionId', () => {
    const client = { id: 'socket-1', join: jest.fn() } as any;
    gateway.handleJoinQr(client, { sessionId: '' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('handleJoinQr does nothing when data is null', () => {
    const client = { id: 'socket-1', join: jest.fn() } as any;
    gateway.handleJoinQr(client, null as any);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('emitConfirmed emits to qr room', () => {
    const emitMock = jest.fn();
    (gateway as any).server = { to: jest.fn().mockReturnValue({ emit: emitMock }) };
    gateway.emitConfirmed('session-1');
    expect((gateway as any).server.to).toHaveBeenCalledWith('qr:session-1');
    expect(emitMock).toHaveBeenCalledWith('qr:confirmed');
  });
});
