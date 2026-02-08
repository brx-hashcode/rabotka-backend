import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user: {
    profileId: string;
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('auth.errors.no_token');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Attach user info to request
      (request as AuthenticatedRequest).user = {
        profileId: payload.sub,
      };

      return true;
    } catch {
      throw new UnauthorizedException('auth.errors.invalid_token');
    }
  }

  private extractToken(request: Request): string | undefined {
    const cookieName =
      this.configService.get<string>('AUTH_COOKIE_NAME') || 'access_token';

    // Try cookie first
    const cookieToken = request.cookies?.[cookieName];
    if (cookieToken) {
      return cookieToken;
    }

    // Fall back to Authorization header
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
  }
}
