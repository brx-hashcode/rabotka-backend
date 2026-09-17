import { WhatsappAdminService } from '../whatsapp-admin.service';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { AdminCacheService } from '../../../common/services/cache/admin-cache.service';
import type { QueueService } from '../../../common/services/queue/queue.service';

/**
 * Received messages share the table with sent ones. Two things follow, and
 * both are pinned here: the delivery figures must not count them, and a row
 * with no name of its own borrows the contact's WhatsApp name.
 */

const CLOUD_ENV = {
  WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_CLOUD_ACCESS_TOKEN: 'test-token',
  WHATSAPP_CLOUD_APP_SECRET: 'test-secret',
  WHATSAPP_CLOUD_VERIFY_TOKEN: 'test-verify',
  WHATSAPP_CLOUD_WABA_ID: '9876543210',
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ...CLOUD_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    created_at: new Date('2026-09-17T09:35:00Z'),
    provider: 'cloud',
    provider_message_id: 'wamid.1',
    direction: 'OUTBOUND',
    to_phone: '+242066294896',
    profile_id: null,
    kind: 'text',
    template_key: null,
    template_category: null,
    body_preview: 'Bonjour',
    variables: null,
    status: 'READ',
    sent_at: null,
    delivered_at: null,
    read_at: null,
    failed_at: null,
    received_at: null,
    wa_profile_name: null,
    error_code: null,
    error_provider_code: null,
    error_message: null,
    pricing_category: null,
    billable: null,
    profile: null,
    sent_by: null,
    ...over,
  };
}

function makeService(prisma: Record<string, unknown>) {
  const cache = {
    wrap: jest.fn(
      (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
    ),
    listKey: jest.fn(() => 'key'),
    dashboardKey: jest.fn(() => 'key'),
  } as unknown as AdminCacheService;
  return new WhatsappAdminService(
    prisma as unknown as PrismaService,
    cache,
    {} as QueueService,
  );
}

describe('listForAdmin WhatsApp name', () => {
  it("uses the row's own name, and the contact's when it has none", async () => {
    const prisma = {
      whatsappMessage: {
        findMany: jest.fn().mockResolvedValue([
          row({
            id: 'in',
            direction: 'INBOUND',
            status: 'RECEIVED',
            wa_profile_name: 'Jean K.',
          }),
          row({ id: 'out' }),
          row({ id: 'other', to_phone: '+242000000000' }),
        ]),
        count: jest.fn().mockResolvedValue(3),
      },
      whatsappContact: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { phone: '+242066294896', wa_profile_name: 'Jean Kouka' },
          ]),
      },
    };

    const result = await makeService(prisma).listForAdmin({
      page: 1,
      limit: 10,
    });

    expect(result.data.map((item) => item.waProfileName)).toEqual([
      'Jean K.',
      'Jean Kouka',
      null,
    ]);
    // Only the rows lacking a name are looked up, once each.
    expect(prisma.whatsappContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: { in: ['+242066294896', '+242000000000'] },
        }),
      }),
    );
  });

  it('skips the contact lookup when every row has a name', async () => {
    const prisma = {
      whatsappMessage: {
        findMany: jest
          .fn()
          .mockResolvedValue([row({ wa_profile_name: 'Jean K.' })]),
        count: jest.fn().mockResolvedValue(1),
      },
      whatsappContact: { findMany: jest.fn() },
    };

    await makeService(prisma).listForAdmin({ page: 1, limit: 10 });

    expect(prisma.whatsappContact.findMany).not.toHaveBeenCalled();
  });
});

describe('statsForAdmin', () => {
  it('computes delivery figures over sent messages only, and counts received apart', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(7);
    const prisma = {
      whatsappMessage: { groupBy, count, findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const stats = await makeService(prisma).statsForAdmin({});

    for (const call of groupBy.mock.calls) {
      expect(call[0].where.direction).toBe('OUTBOUND');
    }
    expect(count).toHaveBeenCalledWith({
      where: { direction: 'INBOUND' },
    });
    expect(stats.received).toBe(7);
    expect(stats.total).toBe(0);

    // Both raw queries filter on direction too.
    for (const call of prisma.$queryRaw.mock.calls) {
      expect((call[0] as string[]).join('?')).toContain(
        "direction = 'OUTBOUND'",
      );
    }
  });
});
