/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for Prisma calls */
import { decodeJwt } from 'jose';
import { ChatMessageKind } from '@prisma/client';
import { ChatCallService, STALE_CALL_MS } from '../chat-call.service';

const me = { first_name: 'Paul', last_name: 'Admin', email: 'paul@x.co' };

function setup(conv: {
  active_call_room?: string | null;
  active_call_started_at?: Date | null;
  type?: 'DIRECT' | 'GROUP';
}) {
  const state = {
    active_call_room: conv.active_call_room ?? null,
    active_call_started_at: conv.active_call_started_at ?? null,
  };
  const card = {
    id: 'm1',
    conversation_id: 'c1',
    sender_id: 'u1',
    kind: ChatMessageKind.CALL,
    metadata: { room: state.active_call_room },
    body: null,
    attachments: null,
    created_at: new Date(Date.now() - 600_000),
    edited_at: null,
    deleted_at: null,
    sender: { first_name: 'Paul', last_name: 'Admin' },
  };
  const prisma = {
    chatConversation: {
      findUnique: jest.fn(async () => ({ ...state })),
      findUniqueOrThrow: jest.fn(async () => ({
        id: 'c1',
        name: 'Team',
        type: conv.type ?? 'GROUP',
        ...state,
        participants: [
          { user_id: 'u1', user: { first_name: 'Paul', last_name: 'Admin' } },
          { user_id: 'u2', user: { first_name: 'Awa', last_name: 'Diop' } },
        ],
      })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.active_call_room !== state.active_call_room)
          return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      }),
    },
    chatMessage: {
      create: jest.fn(async ({ data }: any) => ({
        ...card,
        metadata: data.metadata,
      })),
      findFirst: jest.fn(async () => card),
      update: jest.fn(async ({ data }: any) => ({
        ...card,
        metadata: data.metadata,
      })),
    },
    chatParticipant: {
      update: jest.fn(),
      findMany: jest.fn(async () => [{ user_id: 'u1' }, { user_id: 'u2' }]),
    },
    user: { findUniqueOrThrow: jest.fn(async () => me) },
  };
  const chat = {
    assertMembership: jest.fn(),
    toMessageItem: (m: any, senderName: string) => ({
      id: m.id,
      senderName,
      kind: m.kind,
      call: m.metadata,
    }),
  };
  const service = new ChatCallService(
    prisma as never,
    { get: (k: string) => ({ JITSI_APP_SECRET: 's' })[k] } as never,
    chat as never,
  );
  return { service, prisma, state, chat };
}

describe('ChatCallService', () => {
  it('starts a call: a CALL card, and only the others are rung', async () => {
    const { service, state } = setup({});
    const r = await service.start('u1', 'c1');
    expect(r.started).toBe(true);
    expect(r.room).toMatch(/^RabotkaTeam-/);
    expect(state.active_call_room).toBe(r.room);
    expect(r.message).toMatchObject({ kind: 'CALL', call: { room: r.room } });
    expect(r.recipientIds).toEqual(['u2']);
  });

  it('joins the call going on instead of starting a second one', async () => {
    const { service, prisma } = setup({
      active_call_room: 'RabotkaTeam-existing',
      active_call_started_at: new Date(),
    });
    const r = await service.start('u2', 'c1');
    expect(r).toMatchObject({ started: false, room: 'RabotkaTeam-existing' });
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('gives every member a moderator token for that room', async () => {
    const { service } = setup({
      active_call_room: 'RabotkaTeam-x',
      active_call_started_at: new Date(),
      type: 'DIRECT',
    });
    const join = await service.join('u1', 'c1');
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    expect(join.title).toBe('Awa Diop');
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.room).toBe('RabotkaTeam-x');
    expect(claims.context.user.moderator).toBe(true);
  });

  it('ends with the last one out, writing the duration on the card', async () => {
    const { service, state } = setup({
      active_call_room: 'RabotkaTeam-x',
      active_call_started_at: new Date(Date.now() - 12 * 60_000),
    });
    expect((await service.leave('u2', 'c1', 1)).ended).toBeNull();
    expect(state.active_call_room).toBe('RabotkaTeam-x');
    const { ended, participantIds } = await service.leave('u1', 'c1', 0);
    expect(state.active_call_room).toBeNull();
    expect(ended?.call).toMatchObject({ room: 'RabotkaTeam-x' });
    expect(ended?.call?.durationSec).toBeGreaterThanOrEqual(12 * 60 - 1);
    expect(participantIds).toEqual(['u1', 'u2']);
  });

  it('treats a call left open for hours as over', async () => {
    const { service } = setup({
      active_call_room: 'RabotkaTeam-old',
      active_call_started_at: new Date(Date.now() - STALE_CALL_MS - 1000),
    });
    const r = await service.start('u1', 'c1');
    expect(r.started).toBe(true);
    expect(r.room).not.toBe('RabotkaTeam-old');
  });

  it('refuses a token once the call has ended', async () => {
    const { service } = setup({});
    await expect(service.join('u1', 'c1')).rejects.toThrow('ended');
  });
});
