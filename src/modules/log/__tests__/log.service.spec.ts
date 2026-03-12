import { Test, TestingModule } from '@nestjs/testing';
import { LogService } from '../log.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { Prisma } from '@prisma/client';

const LOG_ID = 'log-uuid-1';
const PROFILE_ID = 'profile-uuid-1';
const USER_ID = 'user-uuid-1';

const mockLog = {
  id: LOG_ID,
  action: 'TEST_ACTION',
  entity_type: 'Profile',
  entity_id: PROFILE_ID,
  user_id: USER_ID,
  profile_id: PROFILE_ID,
  metadata: { key: 'value' },
  created_at: new Date(),
  user: { first_name: 'John', last_name: 'Doe' },
};

describe('LogService', () => {
  let service: LogService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrismaService = {
      log: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([mockLog]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LogService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<LogService>(LogService);
    prisma = module.get(PrismaService);
  });

  describe('create()', () => {
    it('creates a log entry with all fields', async () => {
      await service.create({
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: USER_ID,
        userId: USER_ID,
        profileId: PROFILE_ID,
        metadata: { reason: 'test' },
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(prisma.log.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'USER_CREATED',
          entity_type: 'User',
          entity_id: USER_ID,
          user_id: USER_ID,
          profile_id: PROFILE_ID,
          ip_address: '127.0.0.1',
          user_agent: 'Mozilla/5.0',
        }),
      });
    });

    it('sets metadata to DbNull when not provided', async () => {
      await service.create({ action: 'SIMPLE_ACTION' });

      expect(prisma.log.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ metadata: Prisma.DbNull }),
      });
    });

    it('sets nullable fields to null when not provided', async () => {
      await service.create({ action: 'MINIMAL' });

      expect(prisma.log.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entity_type: null,
          entity_id: null,
          user_id: null,
          profile_id: null,
        }),
      });
    });
  });

  describe('getByProfileId()', () => {
    it('returns formatted log entries for a profile', async () => {
      const result = await service.getByProfileId(PROFILE_ID);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(LOG_ID);
      expect(result[0].action).toBe('TEST_ACTION');
      expect(result[0].userName).toBe('John Doe');
      expect(result[0].metadata).toEqual({ key: 'value' });
    });

    it('returns null userName when no user associated', async () => {
      (prisma.log.findMany as jest.Mock).mockResolvedValue([
        { ...mockLog, user: null },
      ]);

      const result = await service.getByProfileId(PROFILE_ID);
      expect(result[0].userName).toBeNull();
    });

    it('queries with profile_id filter and desc ordering', async () => {
      await service.getByProfileId(PROFILE_ID);

      expect(prisma.log.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { profile_id: PROFILE_ID },
          orderBy: { created_at: 'desc' },
          take: 50,
        }),
      );
    });

    it('returns empty array when no logs found', async () => {
      (prisma.log.findMany as jest.Mock).mockResolvedValue([]);
      const result = await service.getByProfileId(PROFILE_ID);
      expect(result).toEqual([]);
    });
  });
});
