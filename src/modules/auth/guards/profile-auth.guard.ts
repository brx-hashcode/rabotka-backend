import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';

@Injectable()
export class ProfileAuthGuard extends JwtAuthGuard {
  canActivate(context: ExecutionContext): boolean {
    const isValid = super.canActivate(context);
    if (!isValid) {
      return false;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.user.type !== 'profile') {
      throw new UnauthorizedException('Accès profil requis');
    }

    if (!request.user.profileId) {
      throw new UnauthorizedException("Token d'authentification profil invalide");
    }

    return true;
  }
}
