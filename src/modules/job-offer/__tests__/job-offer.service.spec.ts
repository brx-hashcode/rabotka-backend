import { AdminCacheService } from '../../../common/services/cache/admin-cache.service';
import { GeoService } from '../../geo/geo.service';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JobOfferService } from '../job-offer.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WalletService } from '../../wallet/wallet.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EmploymentType, JobOfferStatus, PaymentFlow } from '@prisma/client';
import { MatchingService } from '../../matching/matching.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { JobNotificationProcessor } from '../notification/job-notification.processor';

const EMPLOYER_ID = 'employer-uuid-1';
const OFFER_ID = 'offer-uuid-1';
const WORKER_ID = 'worker-uuid-1';

function futureDate(hoursFromNow = 5): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const baseDto = {
  title: 'Plombier pour urgence',
  description:
    'Réparation fuite eau cuisine, remplacement robinet, vérification tuyauterie.',
  scheduled_at: futureDate(5),
  amount: 15000,
  payment_flow: PaymentFlow.DAILY,
  address: '123 Avenue de la Paix, Poto-Poto',
  quantity: 2,
  // Optional on the DTO, but declared here so the type-narrowing tests below
  // can override it without casting through `unknown`.
  employment_type: undefined as EmploymentType | undefined,
};

const mockOffer = {
  id: OFFER_ID,
  reference: 'RBT-ABCDE',
  employer_id: EMPLOYER_ID,
  title: 'Plombier pour urgence',
  description: 'Réparation fuite eau cuisine',
  scheduled_at: new Date(futureDate(5)),
  amount: 15000,
  payment_flow: 'DAILY',
  address: '123 Avenue de la Paix, Poto-Poto',
  note: null,
  quantity: 2,
  status: 'ACTIVE',
  created_at: new Date(),
  updated_at: new Date(),
  _count: { applications: 0 },
};

describe('JobOfferService', () => {
  let service: JobOfferService;
  let prisma: jest.Mocked<PrismaService>;
  let mailService: jest.Mocked<MailService>;
  let systemConfigService: jest.Mocked<SystemConfigService>;
  let walletService: jest.Mocked<WalletService>;
  let botNotificationService: jest.Mocked<BotNotificationService>;
  let jobNotification: jest.Mocked<JobNotificationProcessor>;

  beforeEach(async () => {
    const mockPrisma = {
      profile: {
        findUnique: jest.fn(),
      },
      jobOffer: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      penalty: {
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const mockMailService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    const mockSystemConfigService = {
      getRaw: jest.fn().mockResolvedValue('0'),
      getFees: jest.fn().mockResolvedValue({
        reliabilityScoreMin: 0,
        jobPostingFeeFcfa: 0,
        cancellationThresholdHours: 4,
        lateCancellationPenaltyFcfa: 5000,
      }),
    };

    const mockWalletService = {
      recordJobPostingPayment: jest.fn().mockResolvedValue(undefined),
    };

    const mockBotNotificationService = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      // Present so "create does not notify anyone itself" is an assertion
      // rather than a matcher error against an undefined property.
      sendRecommendedJobNotification: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          // The real GeoService: it has no dependencies beyond a checked-in
          // JSON file, so a mock would only weaken the location assertions.
          provide: GeoService,
          useValue: new GeoService(),
        },
        {
          // Pass-through cache: the loader always runs, so these specs keep
          // exercising the real queries rather than a cached value.
          provide: AdminCacheService,
          useValue: {
            wrap: (_k: string, _t: number, loader: () => unknown) => loader(),
            listKey: (e: string) => e,
            dashboardKey: (e: string) => e,
            invalidate: jest.fn(),
          },
        },
        JobOfferService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMailService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: WalletService, useValue: mockWalletService },
        {
          provide: BotNotificationService,
          useValue: mockBotNotificationService,
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: MatchingService,
          useValue: {
            indexJobOffer: jest.fn().mockResolvedValue(undefined),
            findMatchingWorkersForJob: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: REDIS_CONNECTION,
          useValue: { set: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: JobNotificationProcessor,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<JobOfferService>(JobOfferService);
    prisma = module.get(PrismaService);
    mailService = module.get(MailService);
    systemConfigService = module.get(SystemConfigService);
    walletService = module.get(WalletService);
    botNotificationService = module.get(BotNotificationService);
    jobNotification = module.get(JobNotificationProcessor);
  });

  describe('create()', () => {
    beforeEach(() => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'ACTIVE',
        profile_type: 'EMPLOYER',
        verification_status: 'VERIFIED',
      });
      (prisma.jobOffer.create as jest.Mock).mockResolvedValue(mockOffer);
    });

    it('creates offer with valid data including quantity', async () => {
      const result = await service.create(EMPLOYER_ID, { ...baseDto });
      expect(result.quantity).toBe(2);
      expect(prisma.jobOffer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ quantity: 2 }),
        }),
      );
    });

    it('hands the worker fan-out to the queue rather than running it inline', async () => {
      // The fan-out used to be a detached promise chain inside `create`, which
      // is why nothing here could assert on it: unretryable, invisible, and
      // lost on restart. `create` now only enqueues.
      await service.create(EMPLOYER_ID, { ...baseDto });

      expect(jobNotification.enqueue).toHaveBeenCalledTimes(1);
      expect(jobNotification.enqueue).toHaveBeenCalledWith(mockOffer.id);
      expect(
        botNotificationService.sendRecommendedJobNotification,
      ).not.toHaveBeenCalled();
    });

    it('defaults quantity to 1 when not provided', async () => {
      const dtoWithoutQuantity = { ...baseDto, quantity: undefined as any };
      (prisma.jobOffer.create as jest.Mock).mockResolvedValue({
        ...mockOffer,
        quantity: 1,
      });
      const result = await service.create(EMPLOYER_ID, dtoWithoutQuantity);
      expect(result.quantity).toBe(1);
    });

    it('throws BadRequestException when quantity < 1', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, quantity: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when quantity > 100', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, quantity: 101 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when employer not found', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when employer is not ACTIVE', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'SUSPENDED',
        profile_type: 'EMPLOYER',
      });
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses an employer whose KYC is not verified', async () => {
      // Mirrors KycVerifiedGuard: enforced here too because the WhatsApp bot
      // reaches this service without passing through any HTTP guard.
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'ACTIVE',
        profile_type: 'EMPLOYER',
        verification_status: 'PENDING',
      });
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.jobOffer.create).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when profile is not EMPLOYER', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when scheduled_at < 4h from now', async () => {
      const dto = { ...baseDto, scheduled_at: futureDate(1) };
      await expect(service.create(EMPLOYER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when amount is below minimum', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, amount: 500 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when amount is above maximum', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, amount: 2_000_000 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findActive()', () => {
    const makeRawOffer = (id: string, overrides = {}) => ({
      ...mockOffer,
      id,
      accepted_count: BigInt(0),
      latitude: null,
      longitude: null,
      category_id: null,
      ...overrides,
    });

    it('returns paginated ACTIVE offers', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        makeRawOffer('offer-1'),
        makeRawOffer('offer-2'),
      ]);
      const result = await service.findActive(5);
      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    /** The cursor is opaque base64url of `scheduledAt|createdAt|id`. */
    const decodeCursor = (c: string) =>
      Buffer.from(c, 'base64url').toString('utf8').split('|');

    it('returns nextCursor when there are more results', async () => {
      const moreOffers = Array.from({ length: 6 }, (_, i) =>
        makeRawOffer(`offer-${i}`),
      );
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(moreOffers);
      const result = await service.findActive(5);
      expect(result.data).toHaveLength(5);

      // Keyset cursor carries every ordered column, not just the id — ordering is
      // by scheduled_at/created_at, so an id-only cursor skipped and repeated rows.
      expect(result.nextCursor).not.toBeNull();
      const [scheduledAt, createdAt, id] = decodeCursor(result.nextCursor!);
      expect(id).toBe('offer-4');
      expect(Number.isNaN(new Date(scheduledAt).getTime())).toBe(false);
      expect(Number.isNaN(new Date(createdAt).getTime())).toBe(false);
    });

    it('derives the cursor from query order, not from the re-ranked page', async () => {
      // Ranking reorders the page for display; the cursor must still point at the
      // last row in SQL order or the next page skips/repeats offers.
      const offers = Array.from({ length: 6 }, (_, i) =>
        makeRawOffer(`offer-${i}`, {
          latitude: 0,
          longitude: i, // increasing distance → ranking reverses the page
          category_id: 'cat-1',
        }),
      );
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(offers);

      const result = await service.findActive(
        5,
        undefined,
        undefined,
        { lat: 0, lng: 0 },
        ['cat-1'],
      );

      const [, , id] = decodeCursor(result.nextCursor!);
      expect(id).toBe('offer-4');
      // ...and the displayed page really was reordered by proximity.
      expect(result.data[0].id).toBe('offer-0');
    });

    it('ignores an unparseable cursor instead of throwing', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        makeRawOffer('offer-1'),
      ]);
      // Old id-only cursors have no meaning under keyset paging.
      await expect(
        service.findActive(5, 'offer-legacy-id'),
      ).resolves.toMatchObject({ nextCursor: null });
    });

    it('excludes offers already applied by a specific worker (calls $queryRaw)', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.findActive(5, undefined, WORKER_ID);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('uses cursor-based pagination when cursor provided (calls $queryRaw)', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.findActive(5, 'some-cursor');
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('omits offers with no open slots (HAVING filters in SQL, raw returns only open slots)', async () => {
      // $queryRaw already filters via HAVING — only open slots are returned
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        makeRawOffer('offer-open', { quantity: 2, accepted_count: BigInt(0) }),
      ]);
      const result = await service.findActive(5);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe('offer-open');
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('every type needs a date', () => {
    /**
     * `scheduled_at` means "the day this offer stops being open", which is true
     * of any offer — for a MISSION it is also the day the work happens, for the
     * rest it is only the application deadline.
     *
     * This used to be MISSION-only, on the reasoning that the others "have no
     * single date". That confused when the job happens with when recruiting
     * stops, and the cost was that every scan keying off this column skipped
     * three of the four types — which is how a hired CDI became an offer that
     * could never close and never be rated.
     */
    it.each([
      EmploymentType.MISSION,
      EmploymentType.CDI,
      EmploymentType.CDD,
      EmploymentType.STAGE,
    ])('rejects a %s with no date', (employment_type) => {
      const { scheduled_at: _omitted, ...noDate } = baseDto;

      expect(() =>
        service.validateCreateDto({
          ...noDate,
          employment_type,
        } as typeof baseDto),
      ).toThrow(BadRequestException);
    });

    it('names the mission date on a MISSION', () => {
      const { scheduled_at: _omitted, ...noDate } = baseDto;

      expect(() => service.validateCreateDto(noDate as typeof baseDto)).toThrow(
        /date de la mission/i,
      );
    });

    it('names the application deadline on an ongoing engagement', () => {
      // The employer is being asked for two different things depending on the
      // type. Demanding "la date de la mission" on a CDI is how you get one
      // invented.
      const { scheduled_at: _omitted, ...noDate } = baseDto;

      expect(() =>
        service.validateCreateDto({
          ...noDate,
          employment_type: EmploymentType.CDI,
        } as typeof baseDto),
      ).toThrow(/clôture des candidatures/i);
    });

    it('defaults to MISSION when the type is unspecified', () => {
      const { scheduled_at: _omitted, ...noDate } = baseDto;

      expect(() =>
        service.validateCreateDto({
          ...noDate,
          employment_type: undefined,
        } as typeof baseDto),
      ).toThrow(/date de la mission/i);
    });

    it('still rejects a malformed date whatever the type', () => {
      expect(() =>
        service.validateCreateDto({
          ...baseDto,
          employment_type: EmploymentType.CDI,
          scheduled_at: 'not-a-date',
        } as typeof baseDto),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateCreateDto()', () => {
    it('throws when title is too short', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, title: 'abc' }),
      ).toThrow(BadRequestException);
    });

    it('throws when title is too long', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, title: 'x'.repeat(101) }),
      ).toThrow(BadRequestException);
    });

    it('throws when description is too short', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, description: 'short' }),
      ).toThrow(BadRequestException);
    });

    it('throws when description is too long', () => {
      expect(() =>
        service.validateCreateDto({
          ...baseDto,
          description: 'x'.repeat(1001),
        }),
      ).toThrow(BadRequestException);
    });

    it('throws when scheduled_at is invalid date format', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, scheduled_at: 'not-a-date' }),
      ).toThrow(BadRequestException);
    });

    it('throws when amount is out of bounds', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, amount: 50 }),
      ).toThrow(BadRequestException);
    });

    it('throws when address is too short', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, address: 'short' }),
      ).toThrow(BadRequestException);
    });

    it('throws when quantity is invalid (0)', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, quantity: 0 }),
      ).toThrow(BadRequestException);
    });

    it('throws when quantity is invalid (> 100)', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, quantity: 200 }),
      ).toThrow(BadRequestException);
    });
  });
  describe('republish()', () => {
    const OFFER_ID = 'offer-1';
    const OWNER_ID = 'employer-1';
    const hoursFromNow = (h: number) =>
      new Date(Date.now() + h * 60 * 60 * 1000);

    const expiredOffer = {
      id: OFFER_ID,
      title: 'Plombier',
      employer_id: OWNER_ID,
      status: JobOfferStatus.EXPIRED,
      deleted_at: null,
    };

    beforeEach(() => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(expiredOffer);
      // Republishing puts a live offer back on the market, so it now also loads
      // the actor to check KYC and account standing.
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        verification_status: 'VERIFIED',
        status: 'ACTIVE',
      });
      (prisma.jobOffer.update as jest.Mock).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...expiredOffer, ...data }),
      );
    });

    it('refuses a suspended employer', async () => {
      // Reopening an expired offer put the employer back on the market, which
      // is the one thing suspending them was supposed to prevent — create() has
      // always refused this, republish() used to let it through.
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        verification_status: 'VERIFIED',
        status: 'SUSPENDED',
      });
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(48)),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.jobOffer.update).not.toHaveBeenCalled();
    });

    it('refuses an employer whose KYC is not verified', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        verification_status: 'PENDING',
        status: 'ACTIVE',
      });
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(48)),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.jobOffer.update).not.toHaveBeenCalled();
    });

    it('reopens the offer at the new date', async () => {
      const when = hoursFromNow(48);
      await service.republish(OFFER_ID, OWNER_ID, when);

      expect(prisma.jobOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: OFFER_ID },
          data: { scheduled_at: when, status: JobOfferStatus.ACTIVE },
        }),
      );
    });

    it('rejects someone who does not own the offer', async () => {
      // The bot flow only ever walked the employer's own queue, so it never
      // needed this. A REST caller supplies an arbitrary id.
      await expect(
        service.republish(OFFER_ID, 'someone-else', hoursFromNow(48)),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.jobOffer.update).not.toHaveBeenCalled();
    });

    it('rejects an offer that is not EXPIRED', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        ...expiredOffer,
        status: JobOfferStatus.ACTIVE,
      });
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(48)),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a date under the minimum lead time', async () => {
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(1)),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.jobOffer.update).not.toHaveBeenCalled();
    });

    it('accepts a date exactly at the boundary', async () => {
      // 4h + a second of slack, since Date.now() advances between the two calls.
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(4 + 1 / 3600)),
      ).resolves.toBeDefined();
    });

    it('rejects an invalid date rather than writing NaN', async () => {
      await expect(
        service.republish(OFFER_ID, OWNER_ID, new Date('not-a-date')),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.jobOffer.update).not.toHaveBeenCalled();
    });

    it('rejects a missing or soft-deleted offer', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(48)),
      ).rejects.toThrow(NotFoundException);

      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        ...expiredOffer,
        deleted_at: new Date(),
      });
      await expect(
        service.republish(OFFER_ID, OWNER_ID, hoursFromNow(48)),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
