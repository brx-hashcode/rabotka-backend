import {
  Injectable,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { deletedAtFilter } from '../../common/utils/soft-delete.util';
import { Prisma, UserRole } from '@prisma/client';
import {
  assertCanAssignRole,
  assertCanManageUser,
} from '../auth/role-seniority';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { AdminListUsersDto } from './dto/admin-list-users.dto';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notification: NotificationService,
  ) {}

  /**
   * The acting admin's current role, read fresh.
   *
   * Not taken from the token — it carries no role claim, deliberately, so that
   * a demotion takes effect immediately rather than whenever the token expires.
   */
  private async actorRole(actorId: string): Promise<UserRole> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true, is_active: true },
    });

    if (!actor?.is_active) {
      throw new ForbiddenException('Accès refusé');
    }

    return actor.role;
  }

  /** Loads the target and refuses if the actor does not outrank them. */
  private async assertMayManage(
    actorId: string,
    targetId: string,
  ): Promise<{ role: UserRole }> {
    const [actor, target] = await Promise.all([
      this.actorRole(actorId),
      this.prisma.user.findUnique({
        where: { id: targetId },
        select: { role: true },
      }),
    ]);

    if (!target) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    assertCanManageUser(actor, target.role);
    return { role: actor };
  }

  async createAdmin(data: CreateAdminDto, actorId: string) {
    assertCanAssignRole(await this.actorRole(actorId), data.role);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException(
        'Un administrateur avec cette adresse email existe déjà',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
        role: data.role,
        is_active: true,
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        is_active: true,
        created_at: true,
        updated_at: true,
      },
    });

    await this.notification.notifyAdminCreated(
      user.email,
      `${user.first_name} ${user.last_name}`,
    );

    return user;
  }

  async updateAdmin(id: string, data: UpdateAdminDto, actorId: string) {
    // Both invariants, because this one method can breach either: acting on a
    // senior account, or promoting one (including your own) above yourself.
    const { role: actorRole } = await this.assertMayManage(actorId, id);
    assertCanAssignRole(actorRole, data.role);

    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    if (data.email !== user.email) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new ConflictException(
          'Un administrateur avec cette adresse email existe déjà',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
        role: data.role,
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        updated_at: true,
      },
    });

    await this.notification.notifyAdminUpdated(
      updated.email,
      `${updated.first_name} ${updated.last_name}`,
    );

    return updated;
  }

  async activate(id: string, actorId: string) {
    await this.assertMayManage(actorId, id);

    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    return this.prisma.user.update({
      where: { id },
      data: { is_active: true },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  async deactivate(id: string, actorId: string) {
    // The escalation this closes is not only "promote myself": deactivating the
    // account above you is the same manoeuvre with a different verb.
    await this.assertMayManage(actorId, id);

    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    return this.prisma.user.update({
      where: { id },
      data: { is_active: false },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    return user;
  }

  async getList(dto: AdminListUsersDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const skip = (page - 1) * limit;

    // Active rows by default; the admin "Deleted" filter flips to archived rows.
    const where: Prisma.UserWhereInput = {
      deleted_at: deletedAtFilter(dto.deleted),
    };

    if (dto.q) {
      where.OR = [
        { first_name: { contains: dto.q, mode: 'insensitive' } },
        { last_name: { contains: dto.q, mode: 'insensitive' } },
        { email: { contains: dto.q, mode: 'insensitive' } },
      ];
    }

    if (dto.role?.length) {
      where.role = { in: dto.role };
    }

    const select = {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      role: true,
      is_active: true,
      last_login_at: true,
      created_at: true,
      updated_at: true,
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        select,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((u) => ({
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        email: u.email,
        role: u.role,
        isActive: u.is_active,
        lastLoginAt: u.last_login_at,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      })),
      total,
      page,
      limit,
    };
  }

  async deleteAdmin(id: string, actorId: string) {
    await this.assertMayManage(actorId, id);

    const user = await this.prisma.user.findFirst({
      where: { id, deleted_at: null },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // Soft delete (archive) — reversible.
    await this.prisma.user.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }

  /** Archive many team members at once (admin bulk delete). Returns the count archived. */
  async bulkSoftDeleteAdmins(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const { count } = await this.prisma.user.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    return { count };
  }

  async findByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    return user;
  }
}
