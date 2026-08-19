import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from '../user.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { UserRole } from '@prisma/client';

const USER_ID = 'user-uuid-1';
const ACTOR_ID = 'actor-uuid-1';

/**
 * Team management now reads the ACTOR as well as the target, so a single
 * `mockResolvedValue` is no longer enough — it would answer the actor lookup
 * with the target row (or with null, which reads as "actor does not exist").
 */
function stubUsers(
  findUnique: jest.Mock,
  opts: {
    actor?: { role: UserRole; is_active: boolean } | null;
    target?: unknown;
    byEmail?: unknown;
  } = {},
) {
  const { actor = { role: UserRole.SUPER_ADMIN, is_active: true } } = opts;
  findUnique.mockImplementation(
    ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.id === ACTOR_ID) return Promise.resolve(actor);
      if (where.email !== undefined)
        return Promise.resolve(opts.byEmail ?? null);
      return Promise.resolve('target' in opts ? opts.target : mockUser);
    },
  );
}

const mockUser = {
  id: USER_ID,
  first_name: 'John',
  last_name: 'Doe',
  email: 'admin@example.com',
  role: UserRole.ADMIN,
  is_active: true,
  last_login_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('UserService', () => {
  let service: UserService;
  let prisma: jest.Mocked<PrismaService>;
  let notification: jest.Mocked<NotificationService>;

  beforeEach(async () => {
    const mockPrismaService = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    const mockNotificationService = {
      notifyAdminCreated: jest.fn().mockResolvedValue(undefined),
      notifyAdminUpdated: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    prisma = module.get(PrismaService);
    notification = module.get(NotificationService);

    stubUsers(prisma.user.findUnique as jest.Mock);
  });

  describe('createAdmin()', () => {
    const dto = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'admin@example.com',
      role: UserRole.ADMIN,
    };

    beforeEach(() => {
      stubUsers(prisma.user.findUnique as jest.Mock, { byEmail: null });
      (prisma.user.create as jest.Mock).mockResolvedValue(mockUser);
    });

    it('creates a new admin user and sends notification', async () => {
      const result = await service.createAdmin(dto, ACTOR_ID);

      expect(result.id).toBe(USER_ID);
      expect(notification.notifyAdminCreated).toHaveBeenCalledWith(
        mockUser.email,
        'John Doe',
      );
    });

    it('throws ConflictException when email already exists', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { byEmail: mockUser });

      await expect(service.createAdmin(dto, ACTOR_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('updateAdmin()', () => {
    const dto = {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'new@example.com',
      role: UserRole.ADMIN,
    };

    beforeEach(() => {
      stubUsers(prisma.user.findUnique as jest.Mock);
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        first_name: 'Jane',
        email: 'new@example.com',
      });
    });

    it('updates admin and sends notification', async () => {
      const result = await service.updateAdmin(USER_ID, dto, ACTOR_ID);

      expect(result.first_name).toBe('Jane');
      expect(notification.notifyAdminUpdated).toHaveBeenCalled();
    });

    it('throws NotFoundException when user not found', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { target: null });

      await expect(service.updateAdmin(USER_ID, dto, ACTOR_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when new email is already taken', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, {
        byEmail: { ...mockUser, id: 'other-user' },
      });

      await expect(service.updateAdmin(USER_ID, dto, ACTOR_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('activate()', () => {
    it('activates the user', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: true,
      });

      const result = await service.activate(USER_ID, ACTOR_ID);
      expect(result.is_active).toBe(true);
    });

    it('throws NotFoundException when user not found', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { target: null });

      await expect(service.activate(USER_ID, ACTOR_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deactivate()', () => {
    it('deactivates the user', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: false,
      });

      const result = await service.deactivate(USER_ID, ACTOR_ID);
      expect(result.is_active).toBe(false);
    });

    it('throws NotFoundException when user not found', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { target: null });

      await expect(service.deactivate(USER_ID, ACTOR_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  /**
   * The hole this closes: `PATCH /user/:id` required only ADMIN, and the
   * service wrote whatever `role` the body carried. An ADMIN could promote
   * themselves to SUPER_ADMIN and then do anything at all.
   */
  describe('seniority invariants', () => {
    const ADMIN_ACTOR = { role: UserRole.ADMIN, is_active: true };

    const dto = {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      role: UserRole.SUPER_ADMIN,
    };

    it('refuses to let an ADMIN promote anyone to SUPER_ADMIN', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { actor: ADMIN_ACTOR });

      await expect(service.updateAdmin(USER_ID, dto, ACTOR_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to let an ADMIN promote THEMSELVES to SUPER_ADMIN', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, {
        actor: ADMIN_ACTOR,
        target: { role: UserRole.ADMIN },
      });

      await expect(
        service.updateAdmin(ACTOR_ID, dto, ACTOR_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to let an ADMIN create a SUPER_ADMIN', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { actor: ADMIN_ACTOR });

      await expect(service.createAdmin(dto, ACTOR_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('refuses to let an ADMIN act on a SUPER_ADMIN', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, {
        actor: ADMIN_ACTOR,
        target: { role: UserRole.SUPER_ADMIN },
      });

      await expect(service.deactivate(USER_ID, ACTOR_ID)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.deleteAdmin(USER_ID, ACTOR_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('still allows a SUPER_ADMIN to assign SUPER_ADMIN', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, { byEmail: null });
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        service.updateAdmin(USER_ID, dto, ACTOR_ID),
      ).resolves.toBeDefined();
    });

    it('allows an ADMIN to manage a MANAGER', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, {
        actor: ADMIN_ACTOR,
        target: { role: UserRole.MANAGER },
      });
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: false,
      });

      await expect(
        service.deactivate(USER_ID, ACTOR_ID),
      ).resolves.toBeDefined();
    });

    it('refuses a deactivated actor', async () => {
      stubUsers(prisma.user.findUnique as jest.Mock, {
        actor: { role: UserRole.SUPER_ADMIN, is_active: false },
      });

      await expect(service.deactivate(USER_ID, ACTOR_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('findById()', () => {
    it('returns user when found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.findById(USER_ID);
      expect(result.id).toBe(USER_ID);
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.findById(USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteAdmin()', () => {
    it('archives the user (soft delete)', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        service.deleteAdmin(USER_ID, ACTOR_ID),
      ).resolves.toBeUndefined();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { deleted_at: expect.any(Date) },
      });
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteAdmin(USER_ID, ACTOR_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getList()', () => {
    it('returns paginated list of users', async () => {
      const users = [mockUser];
      (prisma.user.findMany as jest.Mock).mockResolvedValue(users);
      (prisma.user.count as jest.Mock).mockResolvedValue(1);

      const result = await service.getList({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('applies search filter when q is provided', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.user.count as jest.Mock).mockResolvedValue(0);

      await service.getList({ q: 'john', page: 1, limit: 10 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('applies role filter when role is provided', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.user.count as jest.Mock).mockResolvedValue(0);

      await service.getList({ role: [UserRole.ADMIN], page: 1, limit: 10 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: { in: [UserRole.ADMIN] },
          }),
        }),
      );
    });
  });

  describe('findByEmail()', () => {
    it('returns user when found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.findByEmail('admin@example.com');
      expect(result.email).toBe('admin@example.com');
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.findByEmail('unknown@example.com')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
