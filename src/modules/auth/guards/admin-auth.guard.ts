import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';

@Injectable()
export class AdminAuthGuard extends JwtAuthGuard {
  canActivate(context: ExecutionContext): boolean {
    // First verify JWT token
    const isValid = super.canActivate(context);
    if (!isValid) {
      return false;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Verify token type is 'admin'
    if (request.user.type !== 'admin') {
      throw new UnauthorizedException('auth.errors.admin_access_required');
    }

    // Verify userId exists
    if (!request.user.userId) {
      throw new UnauthorizedException('auth.errors.invalid_admin_token');
    }

    return true;
  }
}
