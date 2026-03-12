import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from '../user.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { UserRole } from '@prisma/client';

const USER_ID = 'user-uuid-1';

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
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
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
  });

  describe('createAdmin()', () => {
    const dto = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'admin@example.com',
      role: UserRole.ADMIN,
    };

    beforeEach(() => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue(mockUser);
    });

    it('creates a new admin user and sends notification', async () => {
      const result = await service.createAdmin(dto);

      expect(result.id).toBe(USER_ID);
      expect(notification.notifyAdminCreated).toHaveBeenCalledWith(
        mockUser.email,
        'John Doe',
      );
    });

    it('throws ConflictException when email already exists', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      await expect(service.createAdmin(dto)).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException for invalid role', async () => {
      await expect(
        service.createAdmin({ ...dto, role: 'INVALID' as UserRole }),
      ).rejects.toThrow(BadRequestException);
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
      (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return Promise.resolve(mockUser);
        if (where.email) return Promise.resolve(null);
        return Promise.resolve(null);
      });
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        first_name: 'Jane',
        email: 'new@example.com',
      });
    });

    it('updates admin and sends notification', async () => {
      const result = await service.updateAdmin(USER_ID, dto);

      expect(result.first_name).toBe('Jane');
      expect(notification.notifyAdminUpdated).toHaveBeenCalled();
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.updateAdmin(USER_ID, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when new email is already taken', async () => {
      (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return Promise.resolve(mockUser);
        if (where.email) return Promise.resolve({ ...mockUser, id: 'other-user' });
        return Promise.resolve(null);
      });

      await expect(service.updateAdmin(USER_ID, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws BadRequestException for invalid role', async () => {
      await expect(
        service.updateAdmin(USER_ID, { ...dto, role: 'INVALID' as UserRole }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('activate()', () => {
    it('activates the user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: true,
      });

      const result = await service.activate(USER_ID);
      expect(result.is_active).toBe(true);
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.activate(USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deactivate()', () => {
    it('deactivates the user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: false,
      });

      const result = await service.deactivate(USER_ID);
      expect(result.is_active).toBe(false);
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deactivate(USER_ID)).rejects.toThrow(NotFoundException);
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

      await expect(service.findById(USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteAdmin()', () => {
    it('deletes the user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.delete as jest.Mock).mockResolvedValue(mockUser);

      await expect(service.deleteAdmin(USER_ID)).resolves.toBeUndefined();
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    });

    it('throws NotFoundException when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteAdmin(USER_ID)).rejects.toThrow(NotFoundException);
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
