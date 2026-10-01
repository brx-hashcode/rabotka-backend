import { ProfileChatGateway } from '../profile-chat.gateway';

const WORKER = 'w-1';
const EMPLOYER = 'e-1';
const CONV = 'c-1';

/**
 * The gateway's inbound surface.
 *
 * This file exists because of one line in `profile-chat.gateway.ts`: for a long
 * time the rule was that this class must not have a `@SubscribeMessage` at all.
 * `typing` is the exception, and these are the conditions it was allowed under
 * — the room from the token and never the payload, membership re-checked
 * against the database, a rate floor, and silence rather than an error when the
 * answer is no.
 */
describe('ProfileChatGateway — typing', () => {
  let gateway: ProfileChatGateway;
  let prisma: {
    profileConversation: { findFirst: jest.Mock };
  };
  let emit: jest.Mock;
  let to: jest.Mock;

  /** A connected socket, registered the way `handleConnection` would. */
  const connect = async (socketId: string, profileId: string) => {
    const client = {
      id: socketId,
      handshake: { auth: { token: profileId }, headers: {} },
      join: jest.fn(),
      disconnect: jest.fn(),
    };
    await gateway.handleConnection(client as never);
    return client;
  };

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });

    prisma = {
      profileConversation: {
        findFirst: jest.fn().mockResolvedValue({
          worker_id: WORKER,
          employer_id: EMPLOYER,
        }),
      },
    };

    const jwt = {
      // The "token" in these tests is the profile id itself.
      verify: jest.fn((token: string) => ({ sub: token, type: 'profile' })),
    };
    const config = { get: jest.fn().mockReturnValue('secret') };
    const presence = {
      connected: jest.fn().mockResolvedValue(undefined),
      disconnected: jest.fn().mockResolvedValue(undefined),
      refresh: jest.fn().mockResolvedValue(undefined),
    };

    gateway = new ProfileChatGateway(
      jwt as never,
      config as never,
      presence as never,
      prisma as never,
      { get: jest.fn().mockResolvedValue(null) } as never,
    );
    gateway.server = { to } as never;
  });

  it('relays to the counterpart, and only to the counterpart', async () => {
    const client = await connect('s-1', WORKER);

    await gateway.handleTyping(client as never, { conversationId: CONV });

    expect(to).toHaveBeenCalledWith(`profile:${EMPLOYER}`);
    expect(to).not.toHaveBeenCalledWith(`profile:${WORKER}`);
    expect(emit).toHaveBeenCalledWith('typing', { conversationId: CONV });
  });

  it('says nothing for a conversation the sender is not in', async () => {
    // The query carries the membership clause, so a stranger's lookup finds
    // nothing. Silence rather than an error: an error would let somebody walk
    // uuids and learn which conversations exist.
    prisma.profileConversation.findFirst.mockResolvedValue(null);
    const client = await connect('s-1', 'stranger');

    await gateway.handleTyping(client as never, { conversationId: CONV });

    expect(emit).not.toHaveBeenCalled();
  });

  it('asks the database with the membership clause, never trusting the payload', async () => {
    const client = await connect('s-1', WORKER);

    await gateway.handleTyping(client as never, { conversationId: CONV });

    const [[query]] = prisma.profileConversation.findFirst.mock.calls;
    expect(query.where.id).toBe(CONV);
    expect(query.where.OR).toEqual([
      { worker_id: WORKER },
      { employer_id: WORKER },
    ]);
    // A closed thread is read-only; nobody is typing into it.
    expect(query.where.closed_at).toBeNull();
  });

  it('ignores an unconnected socket', async () => {
    await gateway.handleTyping({ id: 'ghost' } as never, {
      conversationId: CONV,
    });

    expect(prisma.profileConversation.findFirst).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('holds a rate floor per socket', async () => {
    const client = await connect('s-1', WORKER);

    await gateway.handleTyping(client as never, { conversationId: CONV });
    await gateway.handleTyping(client as never, { conversationId: CONV });
    await gateway.handleTyping(client as never, { conversationId: CONV });

    // The client throttles too, but the client is not the one to be trusted.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('caches the membership instead of querying on every keystroke', async () => {
    const first = await connect('s-1', WORKER);
    const second = await connect('s-2', WORKER);

    await gateway.handleTyping(first as never, { conversationId: CONV });
    await gateway.handleTyping(second as never, { conversationId: CONV });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(prisma.profileConversation.findFirst).toHaveBeenCalledTimes(1);
  });

  it("forgets a profile's cached membership once its last socket is gone", async () => {
    const client = await connect('s-1', WORKER);
    await gateway.handleTyping(client as never, { conversationId: CONV });

    gateway.handleDisconnect(client as never);

    const again = await connect('s-2', WORKER);
    await gateway.handleTyping(again as never, { conversationId: CONV });

    expect(prisma.profileConversation.findFirst).toHaveBeenCalledTimes(2);
  });

  it('survives a database that is down', async () => {
    prisma.profileConversation.findFirst.mockRejectedValue(
      new Error('connection refused'),
    );
    const client = await connect('s-1', WORKER);

    await expect(
      gateway.handleTyping(client as never, { conversationId: CONV }),
    ).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('ProfileChatGateway — emitDeleted', () => {
  it('carries the ids and no content', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const gateway = new ProfileChatGateway(
      { verify: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    gateway.server = { to } as never;

    gateway.emitDeleted(EMPLOYER, CONV, 'm-1');

    expect(to).toHaveBeenCalledWith(`profile:${EMPLOYER}`);
    expect(emit).toHaveBeenCalledWith('message:deleted', {
      conversationId: CONV,
      messageId: 'm-1',
    });
  });
});
