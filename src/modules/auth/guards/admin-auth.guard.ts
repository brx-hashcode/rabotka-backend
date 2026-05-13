import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';

@Injectable()
export class AdminAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isValid = await super.canActivate(context);
    if (!isValid) {
      return false;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.user.type !== 'admin') {
      throw new UnauthorizedException('Accès administrateur requis');
    }

    if (!request.user.userId) {
      throw new UnauthorizedException(
        "Token d'authentification administrateur invalide",
      );
    }

    return true;
  }
}
