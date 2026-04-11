import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from './jwt-auth.guard';

const ROLE_HIERARCHY: Record<UserRole, number> = {
  [UserRole.MODERATOR]: 1,
  [UserRole.MANAGER]: 2,
  [UserRole.ADMIN]: 3,
  [UserRole.SUPER_ADMIN]: 4,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.userId;

    if (!userId) {
      throw new ForbiddenException('Accès refusé');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, is_active: true },
    });

    if (!user || !user.is_active) {
      throw new ForbiddenException('Accès refusé');
    }

    const userLevel = ROLE_HIERARCHY[user.role];
    const requiredLevel = Math.min(
      ...requiredRoles.map((r) => ROLE_HIERARCHY[r]),
    );

    if (userLevel >= requiredLevel) {
      return true;
    }

    throw new ForbiddenException(
      "Vous n'avez pas les permissions nécessaires pour cette action",
    );
  }
}
