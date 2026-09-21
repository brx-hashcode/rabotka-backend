import { BadRequestException } from '@nestjs/common';
import { BroadcastStatus, DeliveryChannel } from '@prisma/client';
import {
  BroadcastService,
  MAX_RECIPIENTS,
  expandChannels,
} from '../broadcast.service';

const BROADCAST_ID = 'b-1';

function makeDeps() {
  const prisma = {
    profile: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    broadcast: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    broadcastRecipient: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  const queue = {
    addJob: jest.fn().mockResolvedValue(undefined),
    getQueue: jest.fn().mockReturnValue({
      remove: jest.fn().mockResolvedValue(undefined),
    }),
  };

  const systemConfig = {
    getMarketingTemplateCostFcfa: jest.fn().mockResolvedValue(15),
  };

  return { prisma, queue, systemConfig };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    status: BroadcastStatus.DRAFT,
    channels: [DeliveryChannel.IN_APP, DeliveryChannel.WHATSAPP],
    audience: {},
    ...overrides,
  };
}

describe('BroadcastService', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: BroadcastService;

  beforeEach(() => {
    deps = makeDeps();
    service = new BroadcastService(
      deps.prisma as never,
      deps.queue as never,
      deps.systemConfig as never,
    );
  });

  describe('preview', () => {
    it('splits WhatsApp reach into free and billable', async () => {
      // total, whatsapp, email, freeWhatsapp — in the order the service awaits.
      deps.prisma.profile.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(30);

      const preview = await service.preview({});

      // The number the admin decides on: 30 of the 80 reachable are inside the
      // 24h window and therefore free; the other 50 are paid templates.
      expect(preview.freeWhatsapp).toBe(30);
      expect(preview.billableWhatsapp).toBe(50);
      expect(preview.reachable).toEqual({
        IN_APP: 100,
        WHATSAPP: 80,
        EMAIL: 12,
      });
    });

    it('counts in-app reach as the whole audience', async () => {
      deps.prisma.profile.count.mockResolvedValue(42);

      const preview = await service.preview({});

      // In-app needs no phone and no address — only an account.
      expect(preview.reachable.IN_APP).toBe(preview.total);
    });
  });

  describe('send', () => {
    it('refuses an audience that matches nobody', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(draft());
      deps.prisma.profile.count.mockResolvedValue(0);

      await expect(service.send(BROADCAST_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(deps.queue.addJob).not.toHaveBeenCalled();
    });

    it('refuses an audience above the per-send ceiling', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(draft());
      deps.prisma.profile.count.mockResolvedValue(MAX_RECIPIENTS + 1);

      // A mistyped filter that widens a segment tenfold must fail loudly, not
      // bill quietly.
      await expect(service.send(BROADCAST_ID)).rejects.toThrow(/limite/);
      expect(deps.prisma.broadcastRecipient.createMany).not.toHaveBeenCalled();
    });

    it('refuses to re-send something already sent', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(
        draft({ status: BroadcastStatus.SENT }),
      );

      await expect(service.send(BROADCAST_ID)).rejects.toThrow(/déjà parti/);
    });

    it('freezes the audience into recipient rows and queues the fan-out', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(draft());
      deps.prisma.profile.count.mockResolvedValue(2);
      // `preview` samples five profiles before the snapshot walks them, so the
      // two calls are told apart by their page size rather than by order.
      let snapshotPage = 0;
      deps.prisma.profile.findMany.mockImplementation(
        ({ take }: { take: number }) => {
          if (take === 5) return Promise.resolve([]);
          snapshotPage += 1;
          return Promise.resolve(
            snapshotPage === 1 ? [{ id: 'p1' }, { id: 'p2' }] : [],
          );
        },
      );
      deps.prisma.broadcastRecipient.createMany.mockResolvedValue({ count: 4 });

      const result = await service.send(BROADCAST_ID);

      // Two profiles × two channels.
      const [{ data }] = deps.prisma.broadcastRecipient.createMany.mock
        .calls[0] as [{ data: Record<string, unknown>[] }];
      expect(data).toHaveLength(4);
      expect(result.recipientCount).toBe(4);
      expect(deps.queue.addJob).toHaveBeenCalledTimes(1);
    });

    it('prices only the billable half of the WhatsApp leg', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(draft());
      deps.prisma.profile.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(4);
      deps.prisma.profile.findMany.mockResolvedValue([]);

      const result = await service.send(BROADCAST_ID);

      // 6 outside the window × 15 FCFA. The 4 inside it are free-form.
      expect(result.estimatedCost).toBe(90);
    });

    it('charges nothing when WhatsApp is not a channel', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(
        draft({ channels: [DeliveryChannel.IN_APP] }),
      );
      deps.prisma.profile.count.mockResolvedValue(10);
      deps.prisma.profile.findMany.mockResolvedValue([]);

      const result = await service.send(BROADCAST_ID);

      expect(result.estimatedCost).toBe(0);
    });

    it('marks a scheduled send SCHEDULED and delays the job', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(draft());
      deps.prisma.profile.count.mockResolvedValue(1);
      deps.prisma.profile.findMany.mockResolvedValue([]);
      const scheduledAt = new Date(Date.now() + 60_000);

      await service.send(BROADCAST_ID, { scheduledAt });

      const [, , opts] = deps.queue.addJob.mock.calls[0] as [
        unknown,
        unknown,
        { delay: number },
      ];
      expect(opts.delay).toBeGreaterThan(0);
      const [{ data }] = deps.prisma.broadcast.update.mock.calls[0] as [
        { data: { status: BroadcastStatus } },
      ];
      expect(data.status).toBe(BroadcastStatus.SCHEDULED);
    });
  });

  describe('cancel', () => {
    it('refuses to cancel something already sent', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(
        draft({ status: BroadcastStatus.SENT }),
      );

      // WhatsApp has no unsend; pretending otherwise would be a lie in the UI.
      await expect(service.cancel(BROADCAST_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('removes the queued job and marks it cancelled', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(
        draft({ status: BroadcastStatus.SENDING }),
      );

      await service.cancel(BROADCAST_ID);

      expect(deps.queue.getQueue).toHaveBeenCalled();
      const [{ data }] = deps.prisma.broadcast.update.mock.calls[0] as [
        { data: { status: BroadcastStatus } },
      ];
      expect(data.status).toBe(BroadcastStatus.CANCELLED);
    });
  });

  describe('update', () => {
    it('refuses to edit a broadcast that is already going out', async () => {
      deps.prisma.broadcast.findUnique.mockResolvedValue(
        draft({ status: BroadcastStatus.SENDING }),
      );

      await expect(
        service.update(BROADCAST_ID, { title: 'Trop tard' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('expandChannels', () => {
    it('turns ALL into the three real channels', () => {
      // A recipient row carrying ALL would be ambiguous at send time, and
      // ambiguity here means either a missing message or a duplicate one.
      expect(expandChannels([DeliveryChannel.ALL]).sort()).toEqual(
        [
          DeliveryChannel.EMAIL,
          DeliveryChannel.IN_APP,
          DeliveryChannel.WHATSAPP,
        ].sort(),
      );
    });

    it('de-duplicates when ALL sits beside an explicit channel', () => {
      expect(
        expandChannels([DeliveryChannel.ALL, DeliveryChannel.EMAIL]),
      ).toHaveLength(3);
    });
  });
});
