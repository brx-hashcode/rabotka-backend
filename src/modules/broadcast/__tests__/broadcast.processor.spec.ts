import { Logger } from '@nestjs/common';
import {
  BroadcastRecipientStatus,
  BroadcastStatus,
  DeliveryChannel,
} from '@prisma/client';
import { BroadcastProcessor } from '../broadcast.processor';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

const BROADCAST_ID = 'b-1';
const RUN_ID = 'run-1';

function broadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    status: BroadcastStatus.SENDING,
    title: 'Maintenance',
    body: 'Rabotka sera en maintenance dimanche.',
    link: null,
    channels: [DeliveryChannel.WHATSAPP],
    sent_count: 0,
    failed_count: 0,
    recipient_count: 0,
    ...overrides,
  };
}

function recipient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    broadcast_id: BROADCAST_ID,
    profile_id: 'p-1',
    channel: DeliveryChannel.WHATSAPP,
    status: BroadcastRecipientStatus.PENDING,
    profile: {
      id: 'p-1',
      phone: '+24200000001',
      email: 'a@b.com',
      first_name: 'Alice',
      whatsapp_connected: true,
    },
    ...overrides,
  };
}

function makeDeps() {
  const prisma = {
    broadcast: {
      findUnique: jest.fn().mockResolvedValue(broadcast()),
      update: jest.fn().mockResolvedValue(broadcast()),
    },
    broadcastRecipient: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue({ broadcast_id: BROADCAST_ID }),
    },
  };
  const queue = { addJob: jest.fn().mockResolvedValue(undefined) };
  const dispatcher = {
    send: jest.fn().mockResolvedValue({ mode: 'TEMPLATE', sent: true }),
    openWindows: jest.fn().mockResolvedValue(new Set<string>()),
  };
  const inApp = { createMany: jest.fn().mockResolvedValue(1) };
  const mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const layout = { wrap: jest.fn().mockResolvedValue('<html/>') };

  return { prisma, queue, dispatcher, inApp, mail, layout };
}

describe('BroadcastProcessor', () => {
  let deps: ReturnType<typeof makeDeps>;
  let processor: BroadcastProcessor;

  beforeEach(() => {
    deps = makeDeps();
    processor = new BroadcastProcessor(
      deps.prisma as never,
      deps.queue as never,
      deps.dispatcher as never,
      deps.inApp as never,
      deps.mail as never,
      deps.layout as never,
    );
  });

  const run = () =>
    processor.process({
      data: {
        type: 'dispatch',
        broadcastId: BROADCAST_ID,
        cursor: 0,
        runId: RUN_ID,
      },
    });

  it('stops immediately when the broadcast was cancelled', async () => {
    deps.prisma.broadcast.findUnique.mockResolvedValue(
      broadcast({ status: BroadcastStatus.CANCELLED }),
    );

    await run();

    // The check that makes "Cancel" mean something: an admin who cancels
    // expects the next page never to be sent.
    expect(deps.prisma.broadcastRecipient.findMany).not.toHaveBeenCalled();
    expect(deps.queue.addJob).not.toHaveBeenCalled();
  });

  it('marks the broadcast SENT when no recipients are left', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([]);

    await run();

    const [{ data }] = deps.prisma.broadcast.update.mock.calls[0] as [
      { data: { status: BroadcastStatus } },
    ];
    expect(data.status).toBe(BroadcastStatus.SENT);
    expect(deps.queue.addJob).not.toHaveBeenCalled();
  });

  it('reads the 24h window once for the whole page, not once per recipient', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([
      recipient({ id: 'r-1', profile_id: 'p-1' }),
      recipient({ id: 'r-2', profile_id: 'p-2' }),
      recipient({ id: 'r-3', profile_id: 'p-3' }),
    ]);

    await run();

    // The entire reason `Profile.last_inbound_at` exists: a query per message
    // is what made every fan-out skip the window check altogether.
    expect(deps.dispatcher.openWindows).toHaveBeenCalledTimes(1);
    expect(deps.dispatcher.openWindows).toHaveBeenCalledWith([
      'p-1',
      'p-2',
      'p-3',
    ]);
  });

  it('passes each recipient’s window verdict to the dispatcher', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([
      recipient({ id: 'r-1', profile_id: 'p-1' }),
      recipient({ id: 'r-2', profile_id: 'p-2' }),
    ]);
    deps.dispatcher.openWindows.mockResolvedValue(new Set(['p-2']));

    await run();

    const calls = deps.dispatcher.send.mock.calls.map(
      ([input]: [{ windowOpen: boolean; profileId: string }]) => input,
    );
    expect(calls.find((c) => c.profileId === 'p-1')?.windowOpen).toBe(false);
    expect(calls.find((c) => c.profileId === 'p-2')?.windowOpen).toBe(true);
  });

  it('writes the in-app leg in one insert and counts it as sent', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([
      recipient({
        id: 'r-1',
        profile_id: 'p-1',
        channel: DeliveryChannel.IN_APP,
      }),
      recipient({
        id: 'r-2',
        profile_id: 'p-2',
        channel: DeliveryChannel.IN_APP,
      }),
    ]);

    await run();

    expect(deps.inApp.createMany).toHaveBeenCalledTimes(1);
    expect(deps.inApp.createMany).toHaveBeenCalledWith(
      ['p-1', 'p-2'],
      expect.objectContaining({ type: 'ANNOUNCEMENT', title: 'Maintenance' }),
    );
    // And no WhatsApp window read at all, since nothing on this page needs one.
    expect(deps.dispatcher.openWindows).not.toHaveBeenCalled();
  });

  it('records a failed send on the recipient row instead of throwing', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([recipient()]);
    deps.dispatcher.send.mockRejectedValue(new Error('131047 out of window'));

    await expect(run()).resolves.toBeUndefined();

    const update = deps.prisma.broadcastRecipient.update.mock.calls[0][0] as {
      data: { status: BroadcastRecipientStatus; error: string };
    };
    expect(update.data.status).toBe(BroadcastRecipientStatus.FAILED);
    expect(update.data.error).toContain('131047');
  });

  // Pentest A2-F20 (#876): the audience is a snapshot, and delivery can come
  // much later. Someone archived or opted out since must get nothing.
  it.each([
    ['archived', { deleted_at: new Date() }],
    ['opted out', { marketing_opt_out_at: new Date() }],
  ])('sends nothing to a recipient %s since scheduling', async (_why, gone) => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([
      recipient({
        profile: { ...recipient().profile, ...gone },
      }),
    ]);

    await run();

    expect(deps.dispatcher.send).not.toHaveBeenCalled();
    const update = deps.prisma.broadcastRecipient.update.mock.calls[0][0] as {
      data: { status: BroadcastRecipientStatus; error: string };
    };
    expect(update.data.status).toBe(BroadcastRecipientStatus.FAILED);
    expect(update.data.error).toBe('Profil archivé ou désinscrit');
  });

  it('skips a recipient with no phone rather than failing the page', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([
      recipient({ profile: { id: 'p-1', phone: null, first_name: 'Alice' } }),
    ]);

    await run();

    expect(deps.dispatcher.send).not.toHaveBeenCalled();
    const update = deps.prisma.broadcastRecipient.update.mock.calls[0][0] as {
      data: { status: BroadcastRecipientStatus };
    };
    expect(update.data.status).toBe(BroadcastRecipientStatus.FAILED);
  });

  it('queues the next page with an advanced cursor', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([
      recipient({ id: 'r-1' }),
      recipient({ id: 'r-2', profile_id: 'p-2' }),
    ]);

    await run();

    const [, data] = deps.queue.addJob.mock.calls[0] as [
      string,
      { cursor: number },
    ];
    expect(data.cursor).toBe(2);
  });

  it('promotes a SCHEDULED broadcast to SENDING on its first page', async () => {
    deps.prisma.broadcast.findUnique.mockResolvedValue(
      broadcast({ status: BroadcastStatus.SCHEDULED }),
    );

    await run();

    const statuses = deps.prisma.broadcast.update.mock.calls.map(
      ([arg]: [{ data: { status?: BroadcastStatus } }]) => arg.data.status,
    );
    expect(statuses).toContain(BroadcastStatus.SENDING);
  });

  it('scopes the next page to this run, so a retry is not dropped', async () => {
    deps.prisma.broadcastRecipient.findMany.mockResolvedValue([recipient()]);

    await run();

    const [, data, opts] = deps.queue.addJob.mock.calls[0] as [
      string,
      { runId: string },
      { jobId: string },
    ];
    // A retry walks the same cursors again. Keyed on the cursor alone, the
    // second run's continuation collided with the first run's completed job,
    // BullMQ dropped it silently, and the broadcast never left SENDING.
    expect(data.runId).toBe(RUN_ID);
    expect(opts.jobId).toContain(RUN_ID);
  });
});
