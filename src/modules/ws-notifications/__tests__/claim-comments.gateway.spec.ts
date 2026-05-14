import { Test, TestingModule } from '@nestjs/testing';
import { ClaimCommentsGateway } from '../claim-comments.gateway';

describe('ClaimCommentsGateway', () => {
  let gateway: ClaimCommentsGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ClaimCommentsGateway],
    }).compile();
    gateway = module.get<ClaimCommentsGateway>(ClaimCommentsGateway);
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    };
  });

  it('handleConnection does not throw', () => {
    expect(() => gateway.handleConnection({ id: 'c-1' } as any)).not.toThrow();
  });

  it('handleDisconnect does not throw', () => {
    expect(() => gateway.handleDisconnect({ id: 'c-1' } as any)).not.toThrow();
  });

  it('handleJoinClaim joins the room', () => {
    const client = { id: 'c-1', join: jest.fn() } as any;
    gateway.handleJoinClaim(client, { claimId: 'claim-1' });
    expect(client.join).toHaveBeenCalledWith('claim:claim-1');
  });

  it('handleJoinClaim does nothing without claimId', () => {
    const client = { id: 'c-1', join: jest.fn() } as any;
    gateway.handleJoinClaim(client, { claimId: '' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('handleJoinClaim does nothing when data is null', () => {
    const client = { id: 'c-1', join: jest.fn() } as any;
    gateway.handleJoinClaim(client, null as any);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('emitNewComment emits to the claim room', () => {
    const emitMock = jest.fn();
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    };
    gateway.emitNewComment('claim-1', { text: 'hello' });
    expect((gateway as any).server.to).toHaveBeenCalledWith('claim:claim-1');
    expect(emitMock).toHaveBeenCalledWith('comment:new', { text: 'hello' });
  });

  it('emitDeletedComment emits to the claim room', () => {
    const emitMock = jest.fn();
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    };
    gateway.emitDeletedComment('claim-1', 'cmt-42');
    expect(emitMock).toHaveBeenCalledWith('comment:deleted', {
      commentId: 'cmt-42',
    });
  });
});
